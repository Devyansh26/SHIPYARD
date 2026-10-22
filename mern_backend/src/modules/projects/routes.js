import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createProject, listProjects, getProject, updateProject, deleteProject } from './repository.js';

// projects.github_url is NOT NULL and (user_id, project_name) is UNIQUE.
// snake_case aliases are accepted because the DB and older clients use them.
const createSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  projectName: z.string().min(2).max(64).optional(),
  githubUrl: z.string().url().optional(),
  github_url: z.string().url().optional(),
}).strict()
  .transform((v) => ({ name: v.name ?? v.projectName, githubUrl: v.githubUrl ?? v.github_url }))
  .refine((v) => !!v.name, { message: 'Required', path: ['name'] })
  .refine((v) => !!v.githubUrl, { message: 'Required (github_url is NOT NULL)', path: ['githubUrl'] });

// github_url cannot be cleared — the column is NOT NULL — so no nullable here.
const patchSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  githubUrl: z.string().url().optional(),
}).strict();

const router = Router();
router.use(requireAuth);

router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const project = await createProject(req.userId, req.body);
  res.status(201).json({ project });
}));

router.get('/', asyncHandler(async (req, res) => {
  const projects = await listProjects(req.userId);
  res.json({ projects, total: projects.length });
}));

router.get('/:projectId', asyncHandler(async (req, res) => {
  res.json({ project: await getProject(req.userId, req.params.projectId) });
}));

router.patch('/:projectId', validate(patchSchema), asyncHandler(async (req, res) => {
  res.json({ project: await updateProject(req.userId, req.params.projectId, req.body) });
}));

router.delete('/:projectId', asyncHandler(async (req, res) => {
  await deleteProject(req.userId, req.params.projectId);
  res.status(204).send();
}));

export default router;
