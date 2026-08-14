import {
  ExchangeMobileAuthorizationCodeBody,
  ExchangeMobileAuthorizationCodeResponse,
  GetCurrentAuthUserResponse,
  LogoutMobileSessionResponse,
} from '@workspace/api-zod';
import { db, usersTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { Router, type IRouter, type Request, type Response } from 'express';
import * as oidc from 'openid-client';
import { z } from 'zod';

import { hashPassword, verifyPassword } from '../lib/password';
import { ensureMembership } from '../services/org';
import { reportCallbackBruteForceBlock } from '../services/security-alerts';
import {
  clearSession,
  createSession,
  deleteSession,
  getOidcConfig,
  getSessionId,
  ISSUER_URL,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from '../lib/auth';
import { createFailureLimiter } from '../lib/rateLimit';

const INVALID_AUTH_WINDOW_MS = 15 * 60 * 1000;
const INVALID_AUTH_MAX_FAILURES = 10;

/**
 * Per-IP throttle on *failed* OIDC / mobile-token-exchange attempts so
 * credential guessing can't be brute-forced. Successful auth is never
 * counted, so legitimate clients are unaffected. Exported for tests.
 *
 * Uses isBlockedShared on the hot path so a freshly restarted instance
 * honours an existing cluster-wide block without needing to see a new
 * failure first (same pattern as invalidApiKeyLimiter in requireMember).
 */
export const invalidAuthAttemptLimiter = createFailureLimiter({
  windowMs: INVALID_AUTH_WINDOW_MS,
  max: INVALID_AUTH_MAX_FAILURES,
  scope: 'session-auth',
});

/**
 * Alias exported for backward compatibility with tests written against
 * the earlier per-route name. Both names refer to the same limiter instance.
 */
export const callbackFailureLimiter = invalidAuthAttemptLimiter;

/**
 * Alias for the mobile token-exchange route's brute-force limiter.
 * The mobile endpoint shares the same underlying limiter so an attacker
 * who pivots from the browser callback to the mobile endpoint still hits
 * the same IP-level block. Exported for tests.
 */
export const mobileTokenFailureLimiter = invalidAuthAttemptLimiter;

const OIDC_COOKIE_TTL = 10 * 60 * 1000;

const router: IRouter = Router();

function getOrigin(req: Request): string {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host =
    req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
  return `${proto}://${host}`;
}

function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
}

// Session cookie for self-hosted (non-OIDC) auth. Secure only in production so
// it still stores over plain http://localhost in local dev.
function setLocalSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
}

function setOidcCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: OIDC_COOKIE_TTL,
  });
}

function getSafeReturnTo(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//')
  ) {
    return '/';
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorStatus(
  value: Record<string, unknown>,
): number | string | undefined {
  if (typeof value.status === 'number' || typeof value.status === 'string') {
    return value.status;
  }
  if (
    typeof value.statusCode === 'number' ||
    typeof value.statusCode === 'string'
  ) {
    return value.statusCode;
  }
  return undefined;
}

function getSafeErrorMetadata(error: unknown) {
  if (!isRecord(error)) {
    return { errorName: typeof error };
  }

  const errorStatus = getErrorStatus(error);
  const causeStatus = isRecord(error.cause)
    ? getErrorStatus(error.cause)
    : undefined;

  return {
    errorName: error instanceof Error ? error.name : 'Error',
    errorStatus: errorStatus ?? causeStatus,
  };
}

async function upsertUser(claims: Record<string, unknown>) {
  const userData = {
    id: claims.sub as string,
    email: (claims.email as string) || null,
    firstName: (claims.first_name as string) || null,
    lastName: (claims.last_name as string) || null,
    profileImageUrl: (claims.profile_image_url || claims.picture) as
      | string
      | null,
  };

  // Invited members are pre-provisioned with a placeholder "invite:" id and
  // their email. On first sign-in, adopt that row (keeping org + role) by
  // re-keying it to the real auth subject.
  if (userData.email) {
    const [invited] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, userData.email.toLowerCase()));
    if (invited && invited.id.startsWith("invite:")) {
      const [adopted] = await db
        .update(usersTable)
        .set({
          id: userData.id,
          firstName: userData.firstName ?? invited.firstName,
          lastName: userData.lastName ?? invited.lastName,
          profileImageUrl: userData.profileImageUrl,
          // A pending invite is intentionally inactive until the invitee
          // proves control of the invited email by completing registration.
          // Successful adoption is the activation boundary.
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, invited.id))
        .returning();
      const adoptedMember = await ensureMembership(adopted.id);
      return adoptedMember ?? adopted;
    }
  }

  const [user] = await db
    .insert(usersTable)
    .values(userData)
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        ...userData,
        updatedAt: new Date(),
      },
    })
    .returning();
  // Attach new users to the default organization (first member = owner).
  const member = await ensureMembership(user.id);
  return member ?? user;
}

router.get('/auth/user', (req: Request, res: Response) => {
  res.json(
    GetCurrentAuthUserResponse.parse({
      user: req.isAuthenticated() ? req.user : null,
    }),
  );
});

router.get('/login', async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;

  const returnTo = getSafeReturnTo(req.query.returnTo);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: 'openid email profile offline_access',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login consent',
    state,
    nonce,
  });

  setOidcCookie(res, 'code_verifier', codeVerifier);
  setOidcCookie(res, 'nonce', nonce);
  setOidcCookie(res, 'state', state);
  setOidcCookie(res, 'return_to', returnTo);

  res.redirect(redirectTo.href);
});

// Query params are not validated because the OIDC provider may include
// parameters not expressed in the schema.
router.get('/callback', async (req: Request, res: Response) => {
  // Block IPs that have exceeded the failed-exchange budget. isBlockedShared
  // falls back to the shared DB counter when the local cache has no entry —
  // so a freshly restarted instance enforces an existing cluster-wide block
  // without needing to see any failures first.
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (await invalidAuthAttemptLimiter.isBlockedShared(ip)) {
    res.status(429).json({ error: 'Too many failed login attempts, please try again later' });
    return;
  }

  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;

  const codeVerifier = req.cookies?.code_verifier;
  const nonce = req.cookies?.nonce;
  const expectedState = req.cookies?.state;

  if (!codeVerifier || !expectedState) {
    res.redirect('/api/login');
    return;
  }

  const currentUrl = new URL(
    `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
  );

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });
  } catch {
    // Count the failure against this IP's budget so repeated bad-code
    // submissions accumulate toward the block threshold.
    const justBlocked = await invalidAuthAttemptLimiter.recordFailure(ip);
    if (justBlocked) {
      void reportCallbackBruteForceBlock({
        ip,
        windowMs: INVALID_AUTH_WINDOW_MS,
        maxFailures: INVALID_AUTH_MAX_FAILURES,
      });
    }
    res.redirect('/api/login');
    return;
  }

  const returnTo = getSafeReturnTo(req.cookies?.return_to);

  res.clearCookie('code_verifier', { path: '/' });
  res.clearCookie('nonce', { path: '/' });
  res.clearCookie('state', { path: '/' });
  res.clearCookie('return_to', { path: '/' });

  const claims = tokens.claims();
  if (!claims) {
    res.redirect('/api/login');
    return;
  }

  const dbUser = await upsertUser(claims as unknown as Record<string, unknown>);

  const now = Math.floor(Date.now() / 1000);
  const sessionData: SessionData = {
    user: {
      id: dbUser.id,
      email: dbUser.email,
      firstName: dbUser.firstName,
      lastName: dbUser.lastName,
      profileImageUrl: dbUser.profileImageUrl,
    },
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : claims.exp,
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);
  res.redirect(returnTo);
});

router.get('/logout', async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const origin = getOrigin(req);
  const returnTo = getSafeReturnTo(req.query.returnTo);
  const postLogoutRedirectUrl = new URL(returnTo, `${origin}/`).href;

  const sid = getSessionId(req);
  await clearSession(res, sid);

  const endSessionUrl = oidc.buildEndSessionUrl(config, {
    client_id: process.env.REPL_ID!,
    post_logout_redirect_uri: postLogoutRedirectUrl,
  });

  res.redirect(endSessionUrl.href);
});

router.post(
  '/mobile-auth/token-exchange',
  async (req: Request, res: Response) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    // isBlockedShared falls back to the shared DB counter when the local cache
    // has no entry for this IP — so a freshly restarted instance enforces an
    // existing cluster-wide block without needing to record a new failure first.
    if (await invalidAuthAttemptLimiter.isBlockedShared(ip)) {
      res.status(429).json({ error: 'Too many failed login attempts, please try again later' });
      return;
    }

    const parsed = ExchangeMobileAuthorizationCodeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required parameters' });
      return;
    }

    const { code, code_verifier, redirect_uri, state, nonce } = parsed.data;

    try {
      const config = await getOidcConfig();

      const callbackUrl = new URL(redirect_uri);
      callbackUrl.searchParams.set('code', code);
      callbackUrl.searchParams.set('state', state);
      callbackUrl.searchParams.set('iss', ISSUER_URL);

      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: code_verifier,
        expectedNonce: nonce ?? undefined,
        expectedState: state,
        idTokenExpected: true,
      });

      const claims = tokens.claims();
      if (!claims) {
        const justBlocked = await invalidAuthAttemptLimiter.recordFailure(ip);
        if (justBlocked) {
          void reportCallbackBruteForceBlock({
            ip,
            windowMs: INVALID_AUTH_WINDOW_MS,
            maxFailures: INVALID_AUTH_MAX_FAILURES,
          });
        }
        res.status(401).json({ error: 'No claims in ID token' });
        return;
      }

      const dbUser = await upsertUser(
        claims as unknown as Record<string, unknown>,
      );

      const now = Math.floor(Date.now() / 1000);
      const sessionData: SessionData = {
        user: {
          id: dbUser.id,
          email: dbUser.email,
          firstName: dbUser.firstName,
          lastName: dbUser.lastName,
          profileImageUrl: dbUser.profileImageUrl,
        },
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : claims.exp,
      };

      const sid = await createSession(sessionData);
      res.json(ExchangeMobileAuthorizationCodeResponse.parse({ token: sid }));
    } catch (err) {
      const justBlocked = await invalidAuthAttemptLimiter.recordFailure(ip);
      if (justBlocked) {
        void reportCallbackBruteForceBlock({
          ip,
          windowMs: INVALID_AUTH_WINDOW_MS,
          maxFailures: INVALID_AUTH_MAX_FAILURES,
        });
      }
      req.log.error(getSafeErrorMetadata(err), 'Mobile token exchange error');
      res.status(500).json({ error: 'Token exchange failed' });
    }
  },
);

router.post('/mobile-auth/logout', async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  if (sid) {
    await deleteSession(sid);
  }
  res.json(LogoutMobileSessionResponse.parse({ success: true }));
});

// ── Self-hosted email + password auth ───────────────────────────────────────
// Replaces the Replit OIDC flow for off-Replit deployments. Reuses the same
// DB-backed session store (createSession) and org-bootstrap path
// (ensureMembership) as OIDC: the first registered user becomes the default
// org's owner; everyone after joins via the self-serve create-org flow.

const RegisterBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
});

const LoginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

function isBetaSelfRegistrationAllowed(email: string): boolean {
  const allowlist = (process.env.BETA_SIGNUP_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  // Production is invite-only unless an address is explicitly allowlisted.
  // Development and test remain open so local setup and existing fixtures work.
  if (allowlist.length === 0) {
    return process.env.NODE_ENV !== 'production';
  }

  return allowlist.includes(email);
}

type SessionUserFields = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
};

function sessionUser(u: SessionUserFields) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    profileImageUrl: u.profileImageUrl,
  };
}

async function startLocalSession(res: Response, user: SessionUserFields) {
  const sid = await createSession({
    user: sessionUser(user),
    access_token: 'local-password-auth',
    // No refresh_token / expires_at → authMiddleware never contacts an IdP.
  });
  setLocalSessionCookie(res, sid);
}

router.post('/auth/register', async (req: Request, res: Response) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'A valid email and a password of at least 8 characters are required',
    });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const { password, firstName, lastName } = parsed.data;

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  // Existing accounts keep the same response regardless of beta-gate state.
  // Only active pre-provisioned invite rows bypass the allowlist because an
  // organization owner has approved their access. Deactivating a pending
  // invite revokes it and must not be undone by the invitee registering later.
  if (existing && !existing.id.startsWith('invite:')) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }
  if (existing?.id.startsWith('invite:') && !existing.isActive) {
    res.status(403).json({
      error: 'This GrowthOS invitation is no longer active. Ask your MogulForge administrator for a new invitation.',
      code: 'BETA_INVITE_REVOKED',
    });
    return;
  }
  if (!existing && !isBetaSelfRegistrationAllowed(email)) {
    res.status(403).json({
      error: 'GrowthOS is currently invite-only. Ask your MogulForge administrator for beta access.',
      code: 'BETA_INVITE_REQUIRED',
    });
    return;
  }

  const passwordHash = await hashPassword(password);

  let dbUser;
  if (existing) {
    const localUserId = crypto.randomUUID();
    const [adopted] = await db
      .update(usersTable)
      .set({
        // Retire the invite placeholder at the same boundary that proves
        // control of the invited address. Leaving an activated account with
        // an "invite:" id makes the team UI and resend endpoint continue to
        // treat it as pending.
        id: localUserId,
        passwordHash,
        firstName: firstName ?? existing.firstName,
        lastName: lastName ?? existing.lastName,
        // The invite was confirmed active above. Completing password
        // registration accepts it and keeps the new member active.
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, existing.id))
      .returning();
    dbUser = (await ensureMembership(adopted.id)) ?? adopted;
  } else {
    const [created] = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
      })
      .returning();
    dbUser = (await ensureMembership(created.id)) ?? created;
  }

  await startLocalSession(res, dbUser);
  res.json({ user: sessionUser(dbUser) });
});

router.post('/auth/login', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (await invalidAuthAttemptLimiter.isBlockedShared(ip)) {
    res
      .status(429)
      .json({ error: 'Too many failed login attempts, please try again later' });
    return;
  }

  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  const email = parsed.data.email.toLowerCase();

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  const ok = !!user && (await verifyPassword(parsed.data.password, user.passwordHash));
  if (!ok) {
    // Count the failure toward this IP's brute-force budget (shared limiter
    // with the OIDC callback so pivoting between routes hits the same block).
    const justBlocked = await invalidAuthAttemptLimiter.recordFailure(ip);
    if (justBlocked) {
      void reportCallbackBruteForceBlock({
        ip,
        windowMs: INVALID_AUTH_WINDOW_MS,
        maxFailures: INVALID_AUTH_MAX_FAILURES,
      });
    }
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  if (!user.isActive) {
    res.status(403).json({ error: 'This account has been deactivated' });
    return;
  }

  await startLocalSession(res, user);
  res.json({ user: sessionUser(user) });
});

router.post('/auth/logout', async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.json({ success: true });
});

// ── Local development only ──────────────────────────────────────────────────
// Off-Replit there is no OIDC provider to complete /login, so this route mints
// a real DB-backed session for a seeded local user through the SAME
// upsertUser + createSession path the OIDC callback uses (so the seeded user
// becomes the default org's owner on a fresh DB). Double-gated on NODE_ENV and
// an explicit ENABLE_DEV_LOGIN flag so it can NEVER activate on Replit, where
// NODE_ENV=production and the flag is unset.
if (
  process.env.NODE_ENV === 'development' &&
  process.env.ENABLE_DEV_LOGIN === 'true'
) {
  router.get('/dev/login', async (req: Request, res: Response) => {
    const dbUser = await upsertUser({
      sub: 'dev-local-user',
      // Must be a real, TLD-bearing address — the AuthUser response schema
      // rejects bare hosts like dev@localhost.
      email: 'dev@example.com',
      first_name: 'Local',
      last_name: 'Dev',
    });
    const sessionData: SessionData = {
      user: {
        id: dbUser.id,
        email: dbUser.email,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        profileImageUrl: dbUser.profileImageUrl,
      },
      access_token: 'dev-local-no-oidc',
      // No refresh_token / expires_at → authMiddleware never contacts OIDC.
    };
    const sid = await createSession(sessionData);
    setLocalSessionCookie(res, sid);
    req.log?.warn('[dev] minted local dev session via ENABLE_DEV_LOGIN');
    res.redirect(getSafeReturnTo(req.query.returnTo));
  });
}

export default router;
