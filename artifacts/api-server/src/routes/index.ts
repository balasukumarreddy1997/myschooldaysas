import type { FastifyPluginAsync } from "fastify";
import healthRouter from "./health";
import identityRouter from "./identity";
import academicRouter from "./academic";
import liveRouter from "./live";
import boardRouter from "./board";
import classroomBoardRouter from "./classroom-board";
import dashboardRouter from "./dashboard";
import learningRouter from "./learning";

const routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRouter);
  await fastify.register(identityRouter);
  await fastify.register(academicRouter);
  await fastify.register(liveRouter);
  await fastify.register(boardRouter);
  await fastify.register(classroomBoardRouter);
  await fastify.register(dashboardRouter);
  await fastify.register(learningRouter);
};

export default routes;
