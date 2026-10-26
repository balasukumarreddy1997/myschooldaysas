import { Router, type IRouter } from "express";
import healthRouter from "./health";
import identityRouter from "./identity";
import academicRouter from "./academic";
import liveRouter from "./live";
import boardRouter from "./board";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(identityRouter);
router.use(academicRouter);
router.use(liveRouter);
router.use(boardRouter);
router.use(dashboardRouter);

export default router;
