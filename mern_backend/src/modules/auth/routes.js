import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../../middleware/auth.js';
import { initiateGithubOAuth, handleGithubCallback, getMe, logout, listRepos, listBranches, listCommits } from './controller.js';

const router = Router();
const oauthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: 'draft-7', legacyHeaders: false });

router.get('/github', oauthLimiter, initiateGithubOAuth);
router.get('/github/callback', oauthLimiter, handleGithubCallback);
router.get('/me', requireAuth, getMe);
router.post('/logout', requireAuth, logout);
router.get('/github/repos', requireAuth, listRepos);
router.get('/github/repos/:owner/:repo/branches', requireAuth, listBranches);
router.get('/github/repos/:owner/:repo/commits', requireAuth, listCommits);

export default router;
