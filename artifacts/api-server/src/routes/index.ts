import { Router, type IRouter } from "express";
import authRouter from "./auth";
import billingWebhookRouter from "./billing-webhook";
import healthRouter from "./health";
import v1Router from "./v1";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(billingWebhookRouter); // public Stripe webhook at /api/billing/webhook
router.use("/v1", v1Router);

export default router;
