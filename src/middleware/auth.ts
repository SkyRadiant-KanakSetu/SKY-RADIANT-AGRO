import { Request, Response, NextFunction } from 'express';

type Role = 'ADMIN' | 'OPS' | 'VIEWER';

function parseApiKeys(raw: string) {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [role, key] = part.split(':').map((v) => v.trim());
      return { role: (role || 'VIEWER').toUpperCase() as Role, key: key || '' };
    })
    .filter((row) => row.key);
}

function parseCookieToken(req: Request) {
  const rawCookie = String(req.header('cookie') || '');
  if (!rawCookie) return '';
  const parts = rawCookie.split(';').map((p) => p.trim());
  const hit = parts.find((p) => p.startsWith('agro_dashboard_key='));
  if (!hit) return '';
  return decodeURIComponent(hit.slice('agro_dashboard_key='.length)).trim();
}

export function getConfiguredApiKeys() {
  return parseApiKeys(process.env.API_KEYS || '');
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const headerToken = String(req.header('x-api-key') || '').trim();
  const cookieToken = parseCookieToken(req);
  const token = headerToken || cookieToken;
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing x-api-key' } });
  }
  const configured = getConfiguredApiKeys();
  const hit = configured.find((row) => row.key === token);
  if (!hit) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
  }
  (req as any).auth = { role: hit.role };
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req as any).auth?.role as Role | undefined;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Insufficient role' } });
    }
    next();
  };
}
