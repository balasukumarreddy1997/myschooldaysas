import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";
import { AccessToken } from "livekit-server-sdk";

if (existsSync(".env")) process.loadEnvFile(".env");

test("real DB: classroom access, board grants/replay, signed attendance and overrides", {
  skip: process.env.RUN_CLASSROOM_INTEGRATION !== "1",
  timeout: 60_000,
}, async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL, "An explicit least-privilege DATABASE_URL is required.");
  const base = process.env.CLASSROOM_TEST_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const sockets = [];
  try {
    const role = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    assert.equal(role.rows[0].rolsuper, false);
    assert.equal(role.rows[0].rolbypassrls, false);
    const orgId = (await pool.query("SELECT id FROM identity.organizations ORDER BY created_at LIMIT 1")).rows[0]?.id;
    assert.ok(orgId, "Development seed must exist.");
    async function db(sql, values = []) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
        const result = await client.query(sql, values);
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const people = (await db(`SELECT u.*, array_agg(r.role) roles FROM identity.users u
      JOIN identity.user_roles r ON r.org_id = u.org_id AND r.user_id = u.id
      WHERE u.org_id = $1 AND u.status = 'active' AND NOT u.must_change_password
      GROUP BY u.id`, [orgId])).rows;
    const assignment = (await db(`SELECT e.section_id, e.student_user_id, st.teacher_user_id
      FROM academic.enrollments e JOIN academic.section_teachers st
        ON st.org_id = e.org_id AND st.section_id = e.section_id
      WHERE e.org_id = $1 AND e.status = 'active' LIMIT 1`, [orgId])).rows[0];
    const teacher = people.find(person => person.id === assignment?.teacher_user_id && person.roles.some(role => ["teacher", "class_teacher", "hod"].includes(role)));
    const student = people.find(person => person.id === assignment?.student_user_id && person.roles.includes("student"));
    const parent = people.find(person => person.roles.includes("parent"));
    assert.ok(teacher && student && parent, "Seed teacher, student and parent are required.");
    const sectionId = assignment.section_id;
    assert.ok(sectionId, "Seed teacher and student must share a section.");
    function jwt(person) {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        id: person.id, sub: person.id, orgId, name: person.name, email: person.email,
        roles: person.roles, mustChangePassword: false,
        iss: "campus-live-identity", aud: "campus-live-web", iat: now, exp: now + 900,
      })).toString("base64url");
      const value = `${header}.${payload}`;
      const secret = process.env.JWT_SECRET ?? "campus-live-development-jwt-secret-not-for-production";
      return `${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`;
    }
    async function api(path, user = teacher, method = "GET", body) {
      const response = await fetch(`${base}/api${path}`, {
        method, headers: { Authorization: `Bearer ${jwt(user)}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      return { status: response.status, body: result };
    }
    const created = await api("/live/sessions", teacher, "POST", {
      title: `Classroom integration ${randomUUID().slice(0, 8)}`,
      startAt: new Date().toISOString(), mode: "section", sectionIds: [sectionId], parentView: false,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sessionId = created.body.id;
    assert.equal((await api(`/live/sessions/${sessionId}/start`, teacher, "POST")).status, 200);
    const details = await api(`/live/sessions/${sessionId}/classroom`);
    assert.equal(details.status, 200);
    assert.ok(details.body.boardId);
    assert.equal(details.body.canDraw, true);
    const boardId = details.body.boardId;
    assert.equal((await api(`/live/sessions/${sessionId}/classroom`, parent)).status, 403);
    assert.equal((await api(`/live/sessions/${sessionId}/attendance`, student, "POST", { studentId: student.id, status: "present" })).status, 403);
    const studentDetails = await api(`/live/sessions/${sessionId}/classroom`, student);
    assert.equal(studentDetails.body.role, "student");
    assert.equal(studentDetails.body.canDraw, false);

    async function connect(user, priorTicket) {
      const ticket = priorTicket ?? (await api(`/board/boards/${boardId}/ticket`, user, "POST")).body.ticket;
      const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/board/boards/${boardId}/ws?ticket=${encodeURIComponent(ticket)}`);
      sockets.push(socket);
      const messages = [];
      socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
      async function wait(predicate) {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const index = messages.findIndex(predicate);
          if (index >= 0) return messages.splice(index, 1)[0];
          if (socket.readyState === WebSocket.CLOSED) throw new Error("WebSocket closed before the expected message.");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error("Timed out waiting for board message.");
      }
      const hello = await wait(message => message.type === "hello");
      return { socket, wait, hello, send: value => socket.send(JSON.stringify(value)) };
    }
    const t = await connect(teacher);
    const s = await connect(student);
    const op = { kind: "stroke", tool: "pen", color: "#173e38", width: 4, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] };
    s.send({ type: "op", id: randomUUID(), op });
    assert.equal((await s.wait(message => message.type === "error")).code, "DRAW_FORBIDDEN");
    t.send({ type: "grant", userId: student.id, canDraw: true });
    assert.equal((await s.wait(message => message.type === "grant")).canDraw, true);
    const opId = randomUUID();
    s.send({ type: "op", id: opId, op });
    assert.equal((await t.wait(message => message.type === "op")).id, opId);
    assert.equal((await s.wait(message => message.type === "op")).seq, 1);
    s.send({ type: "op", id: opId, op });
    await s.wait(message => message.type === "op");
    assert.equal(Number((await db("SELECT count(*) count FROM board.ops WHERE org_id = $1 AND board_id = $2", [orgId, boardId])).rows[0].count), 1);
    const replay = await connect(student);
    assert.equal(replay.hello.ops.length, 1);
    t.send({ type: "grant", userId: student.id, canDraw: false });
    await s.wait(message => message.type === "grant");
    s.send({ type: "op", id: randomUUID(), op });
    assert.equal((await s.wait(message => message.type === "error")).code, "DRAW_FORBIDDEN");

    const now = Math.floor(Date.now() / 1000);
    await db("UPDATE live.sessions SET started_at = to_timestamp($3) WHERE org_id = $1 AND id = $2", [orgId, sessionId, now - 60]);
    async function webhook(kind, createdAt, id = randomUUID(), invalid = false) {
      const body = JSON.stringify({
        event: kind, id, createdAt: String(createdAt),
        room: { name: `campus-${orgId}-${sessionId}` },
        participant: { identity: student.id, sid: `PA_test_${sessionId}`, joinedAt: String(now - 50) },
      });
      const token = new AccessToken(process.env.LIVEKIT_API_KEY ?? "devkey", process.env.LIVEKIT_API_SECRET ?? "secret", { ttl: "1h" });
      token.sha256 = createHash("sha256").update(body).digest("base64");
      const response = await fetch(`${base}/api/live/livekit/webhook`, {
        method: "POST", headers: { "Content-Type": "application/webhook+json", Authorization: invalid ? "forged" : await token.toJwt() }, body,
      });
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await webhook("participant_joined", now - 50, randomUUID(), true)).status, 401);
    assert.equal((await webhook("participant_joined", now - 50)).status, 200);
    const leaveId = randomUUID();
    assert.equal((await webhook("participant_left", now - 5, leaveId)).body.accepted, true);
    assert.equal((await webhook("participant_left", now - 5, leaveId)).body.accepted, false);
    assert.equal((await api(`/live/sessions/${sessionId}/end`, teacher, "POST")).status, 200);
    let attendance = (await api(`/live/sessions/${sessionId}/attendance`, student)).body.items;
    assert.equal(attendance.length, 1);
    assert.equal(attendance[0].seconds, 45);
    assert.equal(attendance[0].status, "present");
    assert.equal((await api(`/live/sessions/${sessionId}/attendance`, teacher, "POST", { studentId: student.id, status: "absent" })).status, 200);
    await webhook("participant_left", now - 5);
    attendance = (await api(`/live/sessions/${sessionId}/attendance`, student)).body.items;
    assert.equal(attendance[0].source, "manual");
    assert.equal(attendance[0].status, "absent");
    assert.equal((await api(`/board/boards/${boardId}/ticket`, teacher, "POST")).status, 409);
    console.log("Verified real DB/HTTP/WebSocket classroom flows; media events were synthetically signed, not real camera/audio.");
  } finally {
    for (const socket of sockets) socket.close();
    await pool.end();
  }
});
