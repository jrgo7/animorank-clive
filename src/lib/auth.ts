import { SvelteKitAuth, type DefaultSession } from '@auth/sveltekit';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Google from '@auth/sveltekit/providers/google';
import { env } from '$env/dynamic/private';
import { db } from './zenstack';

declare module '@auth/sveltekit' {
  interface Session {
    user: {
      userId: string;
      type?: 'student' | 'teacher';
      hasAcceptedTOS: boolean;
      /** Operator flag: teachers only, and only the analytics pages read it. */
      admin: boolean;
      /**
       * By default, TypeScript merges new interface properties and overwrites existing ones.
       * In this case, the default session user properties will be overwritten,
       * with the new ones defined above. To keep the default session user properties,
       * you need to add them back into the newly declared interface.
       */
    } & DefaultSession['user'];
  }
}

/**
 * The addresses `WHITELISTED_EMAILS` names, as the set sign-ins are checked
 * against. Comma-separated; each entry is trimmed and lowercased because the
 * provider lowercases the address before this callback sees it. Unset — or
 * nothing but separators — is a list that admits nobody.
 */
export function whitelistedEmails(value: string | undefined): Set<string> {
  const emails = new Set<string>();
  for (const entry of (value ?? '').split(',')) {
    const email = entry.trim().toLowerCase();
    if (email) emails.add(email);
  }
  return emails;
}

/**
 * Whether the sign-in policy admits `email`: an address an operator listed in
 * `WHITELISTED_EMAILS`, or one `TeacherList` marks as a teacher. A whitelisted
 * address is admitted without asking the database at all.
 */
export async function admitsEmail(email: string): Promise<boolean> {
  if (whitelistedEmails(env.WHITELISTED_EMAILS).has(email)) return true;

  const teacher = await db.teacherList.findUnique({ where: { email } });
  return teacher !== null;
}

export const { handle } = SvelteKitAuth({
  providers: [
    Google({
      authorization: {
        params: {
          prompt: 'consent'
        }
      }
    })
  ],
  adapter: PrismaAdapter(db),
  callbacks: {
    async session({ session, user }) {
      const dbUser = await db.user.findUnique({
        where: { id: user.id },
        include: { student: true, teacher: true }
      });

      if (!dbUser) return session;

      if (dbUser.teacher) {
        session.user.type = 'teacher';
      } else {
        session.user.type = 'student';
      }

      session.user.hasAcceptedTOS = dbUser.hasAcceptedTOS;
      session.user.admin = dbUser.admin;

      return session;
    },
    /**
     * Sign-in is restricted on purpose: only an address an operator listed in
     * `WHITELISTED_EMAILS`, or one `TeacherList` marks as a teacher, is
     * admitted. Any other address is refused rather than created as an account
     * — with the variable unset, that is every address but a teacher's.
     *
     * Addresses are compared lowercased: the provider lowercases the address
     * before this callback, so the whitelist is parsed lowercase and
     * `TeacherList` rows must be stored lowercase too. A row containing
     * uppercase can never match — the teacher it names is silently demoted to
     * `Student` by `events.signIn` — so store addresses lowercase. Do not add
     * case folding here without deciding the policy again.
     */
    async signIn({ user }) {
      if (!user.email || !user.id) return false;
      return admitsEmail(user.email);
    }
  },
  events: {
    async signIn({ user }) {
      if (!user.email || !user.id) return;
      const teacher = await db.teacherList.findUnique({ where: { email: user.email } });
      const obj = { id: user.id };
      await db.student.upsert({ create: obj, update: {}, where: obj });
      if (teacher) {
        await db.teacher.upsert({ create: obj, update: {}, where: obj });
      }
    }
  },
  trustHost: true
});
