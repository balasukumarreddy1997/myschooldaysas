import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "./auth";

declare module "fastify" {
  interface FastifyRequest {
    campusUser?: AuthUser;
  }

  interface FastifyReply {
    json(payload: unknown): FastifyReply;
  }
}

type ApiRequest = FastifyRequest<{
  Params: Record<string, string>;
  Querystring: Record<string, unknown>;
  Body: unknown;
}>;
type Next = (error?: unknown) => void;
type RouteHandler = (
  request: ApiRequest,
  reply: FastifyReply,
  next: Next,
) => void | Promise<void>;
type PreHandler = (request: ApiRequest, reply: FastifyReply) => void | Promise<unknown>;
type RoutePart = RouteHandler | PreHandler;
type Method = "GET" | "POST" | "PATCH" | "DELETE";

export function createRouteRegistrar(fastify: FastifyInstance) {
  const register = (method: Method, url: string, ...parts: RoutePart[]) => {
    const handler = parts.at(-1) as RouteHandler | undefined;
    if (!handler) throw new Error(`Missing handler for ${method} ${url}`);
    const preHandler = parts.slice(0, -1) as PreHandler[];

    fastify.route({
      method,
      url,
      preHandler,
      handler: async (request, reply) => {
        await handler(request, reply, (error) => {
          if (error) throw error;
        });
      },
    });
  };

  return {
    get: (url: string, ...parts: RoutePart[]) => register("GET", url, ...parts),
    post: (url: string, ...parts: RoutePart[]) => register("POST", url, ...parts),
    patch: (url: string, ...parts: RoutePart[]) => register("PATCH", url, ...parts),
    delete: (url: string, ...parts: RoutePart[]) => register("DELETE", url, ...parts),
  };
}
