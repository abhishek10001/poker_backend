import { nanoid, customAlphabet } from 'nanoid';
import crypto from 'crypto';

const generateGameId = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 6);

const generatePlayerId = () => nanoid(12);

const generateSessionToken = () => crypto.randomBytes(16).toString('hex');

export { generateGameId, generatePlayerId, generateSessionToken };
