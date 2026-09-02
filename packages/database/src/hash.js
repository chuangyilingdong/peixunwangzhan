import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
const PEPPER = process.env.AUTH_PEPPER || 'p0-local-pepper';
export function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return `scrypt:${salt}:${scryptSync(`p0-local-pepper:${password}`,salt,64).toString('hex')}`; }
