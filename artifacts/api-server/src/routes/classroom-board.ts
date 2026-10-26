import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withOrg } from "@workspace/db";
import { CreateBoardTemplateBody } from "@workspace/api-zod";
import { boardAccess } from "../lib/classroom-board";
import { requireAuth, type AuthUser } from "../lib/auth";

const stroke = z.object({
  kind: z.literal("stroke"),
  tool: z.enum(["pen", "highlighter", "eraser"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  width: z.number().min(1).max(50),
  points: z.array(z.object({
    x: z.number().finite().min(0).max(1600),
    y: z.number().finite().min(0).max(900),
  })).min(1).max(800),
}).strict();
const frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("op"), id: z.string().uuid(), op: stroke }).strict(),
  z.object({ type: z.literal("config"), config: CreateBoardTemplateBody.shape.config }).strict(),
  z.object({ type: z.literal("grant"), userId: z.string().uuid(), canDraw: z.boolean() }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);

type Socket = { readyState: number; send(data: string): void; close(code?: number, reason?: string): void };
const peers = new Map<string, Set<Socket>>();
const tickets = new Map<string, { user: AuthUser; boardId: string; expiresAt: number }>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function broadcast(boardId: string, payload: object) {
  const message = JSON.stringify(payload);
  for (const socket of peers.get(boardId) ?? []) if (socket.readyState === 1) socket.send(message);
}
export function closeBoardConnections(boardId: string) {
  broadcast(boardId, { type: "closed" });
  for (const socket of peers.get(boardId) ?? []) socket.close(1000, "Class ended");
  peers.delete(boardId);
}
function error(socket: Socket, code: string, message: string) {
  if (socket.readyState === 1) socket.send(JSON.stringify({ type: "error", code, message }));
}

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { boardId: string } }>("/board/boards/:boardId/ticket", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.campusUser!;
    await withOrg(user.orgId, async client => {
      const { board, access } = await boardAccess(client, user, request.params.boardId);
      if (board.status !== "open" || access.status !== "live") {
        throw Object.assign(new Error("This board is closed."), { status: 409, code: "BOARD_CLOSED" });
      }
    });
    for (const [key, value] of tickets) if (value.expiresAt < Date.now()) tickets.delete(key);
    if (tickets.size >= 3000) return reply.code(503).send({ error: { code: "BOARD_BUSY", message: "Try joining again shortly." } });
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(hash(ticket), { user, boardId: request.params.boardId, expiresAt: Date.now() + 30_000 });
    return reply.send({ ticket });
  });

  fastify.get<{ Params: { boardId: string }; Querystring: { ticket?: string } }>(
    "/board/boards/:boardId/ws",
    { websocket: true },
    (socket, request) => {
      const raw = request.query.ticket;
      const credential = raw && tickets.get(hash(raw));
      if (raw) tickets.delete(hash(raw)); // one use even if the board or org does not match
      if (!credential || credential.expiresAt < Date.now() || credential.boardId !== request.params.boardId) {
        socket.close(1008, "Invalid classroom ticket");
        return;
      }
      const { user, boardId } = credential;
      const send = (value: object) => { if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
      let active = true;
      let queue = Promise.resolve();
      let lastSecond = 0;
      let messagesThisSecond = 0;

      const initialize = async () => {
        const hello = await withOrg(user.orgId, async client => {
          const { board, access, canDraw } = await boardAccess(client, user, boardId);
          if (board.status !== "open" || access.status !== "live") {
            throw Object.assign(new Error("This board is closed."), { status: 409, code: "BOARD_CLOSED" });
          }
          const count = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM board.ops WHERE org_id = $1 AND board_id = $2", [user.orgId, boardId]);
          if (Number(count.rows[0]?.count) > 5000) {
            throw Object.assign(new Error("The board has exceeded the live replay limit."), { status: 413, code: "BOARD_TOO_LARGE" });
          }
          const ops = await client.query("SELECT seq::text, id, user_id AS \"userId\", op FROM board.ops WHERE org_id = $1 AND board_id = $2 ORDER BY seq", [user.orgId, boardId]);
          return { type: "hello", seq: Number(board.seq), config: board.config, ops: ops.rows.map(({ seq, ...op }) => ({ ...op, seq: Number(seq) })), canDraw, canManage: access.canManage };
        });
        if (!active) return;
        const room = peers.get(boardId) ?? new Set<Socket>();
        room.add(socket);
        peers.set(boardId, room);
        send(hello);
      };
      const receive = async (input: Buffer) => {
        if (!active) return;
        const second = Math.floor(Date.now() / 1000);
        if (lastSecond !== second) { lastSecond = second; messagesThisSecond = 0; }
        if (++messagesThisSecond > 30) { socket.close(1008, "Board rate limit"); return; }
        const parsed = frame.safeParse(JSON.parse(input.toString()));
        if (!parsed.success) { error(socket, "INVALID_FRAME", "Invalid board message."); return; }
        if (parsed.data.type === "ping") { send({ type: "pong" }); return; }
        const payload = await withOrg(user.orgId, async client => {
          const { board, access, canDraw } = await boardAccess(client, user, boardId);
          if (board.status !== "open" || access.status !== "live") {
            throw Object.assign(new Error("The class has ended."), { status: 409, code: "BOARD_CLOSED" });
          }
          const frame = parsed.data;
          if (frame.type === "op") {
            if (!canDraw || !board.config.tools?.includes(frame.op.tool) ||
              (access.role === "student" && !board.config.participants.studentTools?.includes(frame.op.tool))) {
              throw Object.assign(new Error("Drawing is not allowed."), { status: 403, code: "DRAW_FORBIDDEN" });
            }
            const existing = await client.query<{ seq: string; op: unknown }>(
              "SELECT seq::text, op FROM board.ops WHERE org_id = $1 AND board_id = $2 AND id = $3", [user.orgId, boardId, frame.id],
            );
            if (existing.rows[0]) return { duplicate: true, type: "op", seq: Number(existing.rows[0].seq), id: frame.id, userId: user.id, op: existing.rows[0].op };
            const next = await client.query<{ seq: string }>(
              "UPDATE board.boards SET seq = seq + 1 WHERE org_id = $1 AND id = $2 RETURNING seq::text", [user.orgId, boardId],
            );
            await client.query(
              "INSERT INTO board.ops (id, org_id, board_id, seq, user_id, op) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
              [frame.id, user.orgId, boardId, next.rows[0]!.seq, user.id, JSON.stringify(frame.op)],
            );
            return { type: "op", seq: Number(next.rows[0]!.seq), id: frame.id, userId: user.id, op: frame.op };
          }
          if (!access.canManage) throw Object.assign(new Error("Only teachers may change the board."), { status: 403, code: "FORBIDDEN" });
          if (frame.type === "config") {
            await client.query("UPDATE board.boards SET config = $3::jsonb WHERE org_id = $1 AND id = $2", [user.orgId, boardId, JSON.stringify(frame.config)]);
            return { type: "config", config: frame.config };
          }
          if (frame.type !== "grant") return { type: "pong" };
          if (board.config.participants.allowDrawGrants !== true) {
            throw Object.assign(new Error("Draw grants are disabled for this board."), { status: 403, code: "GRANTS_DISABLED" });
          }
          const enrolled = await client.query(
            `SELECT 1 FROM live.session_sections ss
              JOIN academic.enrollments e ON e.org_id = ss.org_id AND e.section_id = ss.section_id
              WHERE ss.org_id = $1 AND ss.session_id = $2 AND e.student_user_id = $3 AND e.status = 'active' LIMIT 1`,
            [user.orgId, board.session_id, frame.userId],
          );
          if (!enrolled.rowCount) throw Object.assign(new Error("Only enrolled students can receive a draw grant."), { status: 403, code: "FORBIDDEN" });
          await client.query(
            `INSERT INTO board.draw_grants (org_id, board_id, user_id, can_draw) VALUES ($1, $2, $3, $4)
              ON CONFLICT (org_id, board_id, user_id) DO UPDATE SET can_draw = EXCLUDED.can_draw`,
            [user.orgId, boardId, frame.userId, frame.canDraw],
          );
          return { type: "grant", userId: frame.userId, canDraw: frame.canDraw };
        });
        if ("duplicate" in payload) send(payload);
        else broadcast(boardId, payload);
      };
      socket.on("message", (input: Buffer) => {
        queue = queue.then(() => receive(input)).catch((cause: unknown) => {
          const issue = cause as { code?: string; message?: string };
          error(socket, issue.code ?? "BOARD_ERROR", issue.message ?? "The board could not process this action.");
        });
      });
      socket.on("close", () => {
        active = false;
        const room = peers.get(boardId);
        room?.delete(socket);
        if (room?.size === 0) peers.delete(boardId);
      });
      void initialize().catch(() => socket.close(1008, "Board access denied"));
    },
  );
};

export default routes;
