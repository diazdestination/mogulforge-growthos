import { Router, type IRouter, type Request, type Response } from 'express';

import { requireMember } from '../../middlewares/requireMember';
import { clearDemoData, seedDemoData } from '../../services/demo-data';

const router: IRouter = Router();

// Populate the caller's org with sample contacts + leads across the pipeline.
router.post(
  '/demo-data',
  requireMember('settings.manage'),
  async (req: Request, res: Response): Promise<void> => {
    const result = await seedDemoData(req.member!.organizationId);
    res.json(result);
  },
);

// Remove the sample data again (only rows this seeder created).
router.delete(
  '/demo-data',
  requireMember('settings.manage'),
  async (req: Request, res: Response): Promise<void> => {
    const result = await clearDemoData(req.member!.organizationId);
    res.json(result);
  },
);

export default router;
