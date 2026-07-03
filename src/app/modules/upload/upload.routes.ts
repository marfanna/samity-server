import { Router } from 'express';
import multer from 'multer';
import { authGuard } from '../../../middleware/authGuard';
import { ApiError } from '../../../utils/ApiError';
import * as ctrl from './upload.controller';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

// In-memory (buffer) storage — files are streamed straight to object storage, never to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    cb(new ApiError(400, 'VALIDATION_ERROR', 'only JPEG/PNG/WebP/HEIC images allowed'));
  },
});

const router = Router();
router.use(authGuard);

// POST /uploads/screenshot — multipart form field: `file`
router.post('/screenshot', upload.single('file'), ctrl.uploadScreenshot);

export const uploadRoutes = router;
