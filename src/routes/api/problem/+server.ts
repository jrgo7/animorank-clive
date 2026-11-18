import z from 'zod';
import type { RequestHandler } from './$types';
import { error, successObject } from '$lib/response';
import { db } from '$lib/zenstack';
import { DEV_ACCESS_BYPASS, unlessDevBypass } from '$lib/devAccessBypass';

const postValidator = z.object({
  problemSet: z.uuid()
});

export const POST: RequestHandler = async ({ locals, request }) => {
  const session = await locals.auth();
  if (!session || !session.user.id) return error(403, 'Unauthorized');
  // DEV_ACCESS_BYPASS — temporary, DO NOT PUSH TO PROD: students may create problems too.
  if (session.user.type != 'teacher' && !DEV_ACCESS_BYPASS) return error(403, 'Unauthorized');

  const { success, data, error: zodError } = await postValidator.safeParseAsync(await request.json());
  if (!success) return error(400, zodError);

  const problemSet = await db.problemSet.findUnique({
    // DEV_ACCESS_BYPASS — temporary, DO NOT PUSH TO PROD: problems can be added to any set.
    where: {
      id: data.problemSet,
      ...unlessDevBypass({ collaborators: { some: { collaborator_id: session.user.id } } })
    }
  });
  if (!problemSet) return error(404, 'Not found');

  const creation = await db.problem.create({
    data: {
      name: 'New Problem',
      description: 'Edit this description.',
      problem_set_id: data.problemSet
    },
    select: { id: true }
  });

  return successObject({ id: creation.id });
};
