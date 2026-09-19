/** 基于 hash 的轻量路由（状态机式，无第三方依赖）。 */

export type RouteName = 'instances' | 'detail' | 'engines' | 'wizard' | 'settings';

export interface Route {
  name: RouteName;
  instanceId: string | null;
  tab: string;
}

export const DETAIL_TABS = ['plugins', 'settings', 'saves', 'logs'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

export function isDetailTab(value: string): value is DetailTab {
  return (DETAIL_TABS as readonly string[]).includes(value);
}

export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = raw.split('?')[0] ?? '';
  const segments = path.split('/').filter((s) => s.length > 0).map((s) => safeDecode(s));
  const head = segments[0] ?? 'instances';

  if (head === 'instance' && segments[1]) {
    const tab = segments[2] ?? 'plugins';
    return {
      name: 'detail',
      instanceId: segments[1],
      tab: isDetailTab(tab) ? tab : 'plugins',
    };
  }
  if (head === 'engines') return { name: 'engines', instanceId: null, tab: '' };
  if (head === 'create') return { name: 'wizard', instanceId: null, tab: '' };
  if (head === 'settings') return { name: 'settings', instanceId: null, tab: '' };
  return { name: 'instances', instanceId: null, tab: '' };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'detail':
      return `#/instance/${encodeURIComponent(route.instanceId ?? '')}/${route.tab}`;
    case 'engines':
      return '#/engines';
    case 'wizard':
      return '#/create';
    case 'settings':
      return '#/settings';
    case 'instances':
    default:
      return '#/instances';
  }
}

const listeners = new Set<(route: Route) => void>();
let current: Route = parseHash(typeof window === 'undefined' ? '' : window.location.hash);

function notify(): void {
  current = parseHash(window.location.hash);
  for (const listener of listeners) listener(current);
}

export function currentRoute(): Route {
  return current;
}

export function onRouteChange(listener: (route: Route) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function startRouter(): void {
  window.addEventListener('hashchange', notify);
  if (!window.location.hash) {
    window.location.replace('#/instances');
  }
  notify();
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (window.location.hash === target) {
    notify();
    return;
  }
  if (options.replace) window.location.replace(target);
  else window.location.hash = target;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
