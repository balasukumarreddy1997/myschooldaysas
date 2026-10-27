import type { FastifyPluginAsync } from "fastify";
import healthRouter from "./health";
import identityRouter from "./identity";
import academicRouter from "./academic";
import liveRouter from "./live";
import boardRouter from "./board";
import classroomBoardRouter from "./classroom-board";
import dashboardRouter from "./dashboard";
import learningRouter from "./learning";
import academicSubjectsRouter from "./academic-subjects";
import academicTimetableRouter from "./academic-timetable";
import schoolRouter from "./school";
import reportCardsRouter from "./report-cards";
import feesRouter from "./fees";
import admissionsRouter from "./admissions";

const routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRouter);
  await fastify.register(identityRouter);
  await fastify.register(academicRouter);
  await fastify.register(academicSubjectsRouter);
  await fastify.register(academicTimetableRouter);
  await fastify.register(schoolRouter);
  await fastify.register(liveRouter);
  await fastify.register(boardRouter);
  await fastify.register(classroomBoardRouter);
  await fastify.register(dashboardRouter);
  await fastify.register(learningRouter);
  await fastify.register(reportCardsRouter);
  await fastify.register(feesRouter);
  await fastify.register(admissionsRouter);
};

export default routes;
