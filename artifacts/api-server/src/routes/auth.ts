import {
  ExchangeMobileAuthorizationCodeBody,
  ExchangeMobileAuthorizationCodeResponse,
  GetCurrentAuthUserResponse,
  LogoutMobileSessionResponse,
} from '@workspace/api-zod';
import { db, sessionsTable, usersTable } from '@workspace/db';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Router, type IRouter, type Request, type Response } from 'express';
import * as oidc from 'openid-client';
import { z } from 'zod';

import { hashPassword, verifyPassword } from '../lib/password';
import { consumeCooldown, createFailureLimiter } from '../lib/rateLimit';
import { recordAudit } from '../services/audit';
import {
  reportIdentityEmailFailure,
  sendEmailVerification,
  sendPasswordReset,
} from '../services/identity-email';
import {
  consumeIdentityToken,
  issueIdentityToken,
} from '../services/identity-token';
import { acceptPendingStaffInvitation, StaffInvitationError } from '../services/staff-invitations';
import { ensureMembership } from '../services/org';
import { isTransactionalEmailConfigured } from '../services/providers';
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

/** OIDC redirect URIs must not inherit caller-controlled Host/proxy headers. */
export function oidcAppOrigin(): string {
  const explicitOrigin =
    process.env.APP_ORIGIN?.trim() || process.env.APP_URL?.trim();
  const replitDomain = process.env.REPLIT_DOMAINS?.split(',')[0]?.trim();
  if (
    !explicitOrigin &&
    replitDomain &&
    !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(replitDomain)
  ) {
    throw new Error('OIDC app origin is invalid');
  }
  const configured =
    explicitOrigin || (replitDomain ? `https://${replitDomain}` : '');
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('APP_ORIGIN is required for OIDC redirects');
  }
  let url: URL;
  try {
    url = new URL(configured || 'http://localhost:5000');
  } catch {
    throw new Error('OIDC app origin is invalid');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('OIDC app origin is invalid');
  }
  return url.origin;
}

export function oidcCallbackUrl(requestUrl?: string): URL {
  const callback = new URL('/api/callback', oidcAppOrigin());
  if (requestUrl) callback.search = new URL(requestUrl, callback).search;
  return callback;
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
    email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null,
    firstName: (claims.first_name as string) || null,
    lastName: (claims.last_name as string) || null,
    profileImageUrl: (claims.profile_image_url || claims.picture) as
      string | null,
    // Signing in proves the IdP identity; mailbox control needs its separate
    // verified-email claim. Preserve established same-mailbox evidence below.
    emailVerifiedAt: claims.email_verified === true ? new Date() : null,
  };

  // Invited members are pre-provisioned with a placeholder "invite:" id and
  // their email. On first sign-in, adopt that row (keeping org + role) by
  // re-keying it to the real auth subject.
  if (userData.email) {
    const [invited] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, userData.email.toLowerCase()));
    if (invited && invited.id.startsWith('invite:')) {
      const adopted = await acceptPendingStaffInvitation({
        pendingUserId: invited.id, email: userData.email, newUserId: userData.id, oidcEmailVerified: claims.email_verified === true,
        firstName: userData.firstName, lastName: userData.lastName,
        profileImageUrl: userData.profileImageUrl, trustedOidc: true,
      });
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
        emailVerifiedAt: userData.emailVerifiedAt ?? sql`case when lower(${usersTable.email}) is not distinct from ${userData.email} then ${usersTable.emailVerifiedAt} else null end`,
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
  const callbackUrl = oidcCallbackUrl().href;

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
    res.status(429).json({
      error: 'Too many failed login attempts, please try again later',
    });
    return;
  }

  const config = await getOidcConfig();
  const currentUrl = oidcCallbackUrl(req.url);

  const codeVerifier = req.cookies?.code_verifier;
  const nonce = req.cookies?.nonce;
  const expectedState = req.cookies?.state;

  if (!codeVerifier || !expectedState) {
    res.redirect('/api/login');
    return;
  }

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

  let dbUser;
  try {
    dbUser = await upsertUser(claims as unknown as Record<string, unknown>);
  } catch (error) {
    if (!(error instanceof StaffInvitationError)) throw error;
    res.status(403).json({ error: 'This invitation cannot be accepted with this sign-in. Use the current emailed invitation link, or ask your administrator to review access.', code: 'INVITATION_ACCEPTANCE_REQUIRED' });
    return;
  }

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
  const origin = oidcAppOrigin();
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
      res.status(429).json({
        error: 'Too many failed login attempts, please try again later',
      });
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
      if (err instanceof StaffInvitationError) {
        res.status(403).json({ error: 'Use the current emailed invitation link or ask your administrator to review access.', code: 'INVITATION_ACCEPTANCE_REQUIRED' });
        return;
      }
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
  inviteToken: z.string().trim().min(1).max(4096).optional(),
});

const LoginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

const EmailOnlyBody = z.object({
  email: z.string().email().max(320),
});

const TokenOnlyBody = z.object({
  token: z.string().trim().min(1).max(512),
});

const ResetPasswordBody = TokenOnlyBody.extend({
  password: z.string().min(8).max(200),
});

const IDENTITY_REQUEST_ACCEPTED = {
  message:
    'If an eligible account exists, MogulForge will send the next step to that email address.',
};

const IDENTITY_COOLDOWN_MS = 15 * 60 * 1000;
const IDENTITY_COOLDOWN_MAX = 3;

function identityCooldownKey(
  purpose: 'email-verification' | 'password-reset',
  email: string,
  ip: string,
): string {
  const digest = createHash('sha256')
    .update(`${email}:${ip}`, 'utf8')
    .digest('hex');
  return `identity:${purpose}:${digest}`;
}

function transactionalEmailUnavailable(res: Response): void {
  res.status(503).json({
    error:
      'MogulForge account email is temporarily unavailable. Please try again later.',
    code: 'IDENTITY_EMAIL_NOT_CONFIGURED',
  });
}

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
      error:
        'A valid email and a password of at least 8 characters are required',
    });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const { password, firstName, lastName, inviteToken } = parsed.data;

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  // Existing accounts keep the same response regardless of beta-gate state.
  // Only active pre-provisioned invite rows bypass the allowlist because an
  // organization owner has approved their access. Deactivating a pending
  // invite revokes it and must not be undone by the invitee registering later.
  if (existing && !existing.id.startsWith('invite:')) {
    res
      .status(409)
      .json({ error: 'An account with this email already exists' });
    return;
  }
  if (existing?.id.startsWith('invite:') && !existing.isActive) {
    res.status(403).json({
      error:
        'This GrowthOS invitation is no longer active. Ask your MogulForge administrator for a new invitation.',
      code: 'BETA_INVITE_REVOKED',
    });
    return;
  }
  if (
    existing?.id.startsWith('invite:') &&
    (!inviteToken ||
      !existing.organizationId ||
      !existing.email)
  ) {
    res.status(403).json({
      error:
        'This invitation link is invalid or has expired. Ask your MogulForge administrator to resend it.',
      code: 'BETA_INVITE_TOKEN_REQUIRED',
    });
    return;
  }
  if (!existing && !isBetaSelfRegistrationAllowed(email)) {
    res.status(403).json({
      error:
        'GrowthOS is currently invite-only. Ask your MogulForge administrator for beta access.',
      code: 'BETA_INVITE_REQUIRED',
    });
    return;
  }

  if (
    !existing &&
    process.env.NODE_ENV === 'production' &&
    !isTransactionalEmailConfigured()
  ) {
    transactionalEmailUnavailable(res);
    return;
  }

  const passwordHash = await hashPassword(password);

  let dbUser;
  if (existing) {
    const localUserId = crypto.randomUUID();
    try {
      const adopted = await acceptPendingStaffInvitation({
        pendingUserId: existing.id, email, newUserId: localUserId, token: inviteToken,
        passwordHash, firstName, lastName,
      });
      dbUser = (await ensureMembership(adopted.id)) ?? adopted;
    } catch (error) {
      if (!(error instanceof StaffInvitationError)) throw error;
      res.status(403).json({ error: 'This invitation changed, was revoked or expired. Ask your administrator for a current invitation.', code: 'BETA_INVITE_TOKEN_REQUIRED' });
      return;
    }
  } else {
    const [created] = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        emailVerifiedAt:
          process.env.NODE_ENV === 'production' ? null : new Date(),
      })
      .returning();
    dbUser = (await ensureMembership(created.id)) ?? created;
  }

  // A signed team invitation already proved mailbox control. Self-serve local
  // registrations must verify their email before we mint an authenticated
  // session in production.
  if (!existing && process.env.NODE_ENV === 'production') {
    const token = await issueIdentityToken({
      userId: dbUser.id,
      purpose: 'email_verification',
    });
    try {
      await sendEmailVerification({
        to: email,
        token,
        firstName: dbUser.firstName,
      });
      if (dbUser.organizationId) {
        void recordAudit({
          organizationId: dbUser.organizationId,
          actorUserId: dbUser.id,
          action: 'identity.email_verification.sent',
          entityType: 'user',
          metadata: { targetUserId: dbUser.id },
        }).catch(() => {});
      }
    } catch (error) {
      // Do not expose provider details or create an account-enumeration side
      // channel. The unverified account can recover via resend verification.
      reportIdentityEmailFailure('email_verification', error);
    }
    res.status(202).json({
      verificationRequired: true,
      message: 'Check your email to verify your GrowthOS account.',
    });
    return;
  }

  await startLocalSession(res, dbUser);
  res.json({ user: sessionUser(dbUser) });
});

router.post('/auth/login', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (await invalidAuthAttemptLimiter.isBlockedShared(ip)) {
    res.status(429).json({
      error: 'Too many failed login attempts, please try again later',
    });
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

  const ok =
    !!user && (await verifyPassword(parsed.data.password, user.passwordHash));
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
  if (!user.emailVerifiedAt) {
    res.status(403).json({
      error: 'Verify your email address before signing in.',
      code: 'EMAIL_VERIFICATION_REQUIRED',
    });
    return;
  }

  await startLocalSession(res, user);
  res.json({ user: sessionUser(user) });
});

router.post('/auth/forgot-password', async (req: Request, res: Response) => {
  if (
    process.env.NODE_ENV === 'production' &&
    !isTransactionalEmailConfigured()
  ) {
    transactionalEmailUnavailable(res);
    return;
  }

  const parsed = EmailOnlyBody.safeParse(req.body);
  if (!parsed.success) {
    // Keep the response indistinguishable from an unknown account.
    res.status(202).json(IDENTITY_REQUEST_ACCEPTED);
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const cooldown = await consumeCooldown({
    key: identityCooldownKey('password-reset', email, ip),
    windowMs: IDENTITY_COOLDOWN_MS,
    max: IDENTITY_COOLDOWN_MAX,
  });
  if (!cooldown.allowed) {
    res.status(202).json(IDENTITY_REQUEST_ACCEPTED);
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  if (user?.isActive && user.passwordHash) {
    try {
      const token = await issueIdentityToken({
        userId: user.id,
        purpose: 'password_reset',
      });
      await sendPasswordReset({
        to: email,
        token,
        firstName: user.firstName,
      });
      if (user.organizationId) {
        void recordAudit({
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'identity.password_reset.requested',
          entityType: 'user',
          metadata: { targetUserId: user.id },
        }).catch(() => {});
      }
    } catch (error) {
      reportIdentityEmailFailure('password_reset', error);
    }
  }

  res.status(202).json(IDENTITY_REQUEST_ACCEPTED);
});

router.post(
  '/auth/resend-verification',
  async (req: Request, res: Response) => {
    if (
      process.env.NODE_ENV === 'production' &&
      !isTransactionalEmailConfigured()
    ) {
      transactionalEmailUnavailable(res);
      return;
    }

    const parsed = EmailOnlyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(202).json(IDENTITY_REQUEST_ACCEPTED);
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const cooldown = await consumeCooldown({
      key: identityCooldownKey('email-verification', email, ip),
      windowMs: IDENTITY_COOLDOWN_MS,
      max: IDENTITY_COOLDOWN_MAX,
    });
    if (!cooldown.allowed) {
      res.status(202).json(IDENTITY_REQUEST_ACCEPTED);
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));

    if (user?.isActive && user.passwordHash && !user.emailVerifiedAt) {
      try {
        const token = await issueIdentityToken({
          userId: user.id,
          purpose: 'email_verification',
        });
        await sendEmailVerification({
          to: email,
          token,
          firstName: user.firstName,
        });
        if (user.organizationId) {
          void recordAudit({
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: 'identity.email_verification.resent',
            entityType: 'user',
            metadata: { targetUserId: user.id },
          }).catch(() => {});
        }
      } catch (error) {
        reportIdentityEmailFailure('email_verification', error);
      }
    }

    res.status(202).json(IDENTITY_REQUEST_ACCEPTED);
  },
);

router.post('/auth/verify-email', async (req: Request, res: Response) => {
  const parsed = TokenOnlyBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'This verification link is invalid or expired.' });
    return;
  }

  const consumed = await consumeIdentityToken({
    token: parsed.data.token,
    purpose: 'email_verification',
  });
  if (!consumed) {
    res
      .status(400)
      .json({ error: 'This verification link is invalid or expired.' });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(usersTable.id, consumed.userId))
    .returning();
  if (!user?.isActive) {
    res
      .status(400)
      .json({ error: 'This verification link is invalid or expired.' });
    return;
  }

  if (user.organizationId) {
    void recordAudit({
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'identity.email_verified',
      entityType: 'user',
      metadata: { targetUserId: user.id },
    }).catch(() => {});
  }
  await startLocalSession(res, user);
  res.json({ success: true, user: sessionUser(user) });
});

router.post('/auth/reset-password', async (req: Request, res: Response) => {
  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        'This reset link is invalid or expired, or the password is too short.',
    });
    return;
  }

  const consumed = await consumeIdentityToken({
    token: parsed.data.token,
    purpose: 'password_reset',
  });
  if (!consumed) {
    res.status(400).json({ error: 'This reset link is invalid or expired.' });
    return;
  }

  const [existingUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, consumed.userId));
  if (!existingUser?.isActive || !existingUser.passwordHash) {
    res.status(400).json({ error: 'This reset link is invalid or expired.' });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const [user] = await db
    .update(usersTable)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(usersTable.id, existingUser.id))
    .returning();

  // Password recovery is a credential rotation boundary. Invalidate every
  // existing browser/mobile session for the account before acknowledging it.
  await db
    .delete(sessionsTable)
    .where(sql`${sessionsTable.sess} -> 'user' ->> 'id' = ${user.id}`);

  if (user.organizationId) {
    void recordAudit({
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'identity.password_reset.completed',
      entityType: 'user',
      metadata: { targetUserId: user.id },
    }).catch(() => {});
  }

  res.json({ success: true, message: 'Your password has been reset.' });
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
