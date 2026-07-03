import { Router } from 'express';
import multer from 'multer';
import { authGuard } from '../../../middleware/authGuard';
import { ApiError } from '../../../utils/ApiError';
import * as ctrl from './upload.controller';

// In-memory (buffer) storage — the buffer is re-encoded to WebP by the service, never hits disk raw.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB raw input (WebP output is far smaller)
  fileFilter: (_req, file, cb) => {
    // Accept any image type; sharp does the real format validation on decode.
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new ApiError(400, 'VALIDATION_ERROR', 'only image files are allowed'));
  },
});

const router = Router();
router.use(authGuard);

// POST /uploads/screenshot — multipart form field: `file`
router.post('/screenshot', upload.single('file'), ctrl.uploadScreenshot);

export const uploadRoutes = router;
