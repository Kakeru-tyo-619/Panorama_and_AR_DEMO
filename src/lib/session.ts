/**
 * 仮ログイン。本番は主サービスの認証（SimpleWebAuthn / セッショントークン）を共用するが、
 * バックエンドがないデモでは、名前ごとのユーザーIDを端末内に保存してセッションの代わりにする。
 * 閲覧はログイン不要、撮影・投稿はログインが必要（設計書 1.4）。
 */
import { createStore } from './store';
import { uuid } from './types';

export type SessionUser = { user_id: string; name: string };

const SESSION_KEY = 'irisona-session';
const USERS_KEY = 'irisona-users';

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const session = createStore({ user: read<SessionUser | null>(SESSION_KEY, null) });

export function login(name: string): SessionUser {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('名前を入力してください');
  const users = read<Record<string, string>>(USERS_KEY, {});
  const user_id = users[trimmed] ?? uuid();
  users[trimmed] = user_id;
  write(USERS_KEY, users);
  const user = { user_id, name: trimmed };
  write(SESSION_KEY, user);
  session.set({ user });
  return user;
}

export function logout() {
  write(SESSION_KEY, null);
  session.set({ user: null });
}

export function userName(user_id: string): string {
  const users = read<Record<string, string>>(USERS_KEY, {});
  return Object.keys(users).find((k) => users[k] === user_id) ?? 'ゲスト';
}
