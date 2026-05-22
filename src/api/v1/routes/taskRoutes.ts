import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { TaskController } from '../controllers/TaskController.js';
import { validateBody } from '../../middleware/validateBody.js';
import { idempotencyGuard } from '../../middleware/idempotencyGuard.js';
import { CreateTaskRequestDTO } from '../../dtos/TransportDTOs.js';

export function createTaskRoutes(controller: TaskController): Router {
  const router = Router();

const taskRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Rate limit exceeded', code: 'RATE_LIMITED' }
});

router.post(
  '/',
  taskRateLimit,
  idempotencyGuard,
  validateBody(CreateTaskRequestDTO),
  (req, res) => controller.createTask(req, res)
);

  return router;
}
