/**
 * 标题栏运行时：WCO 预留宽度同步、拖拽区标题、失焦态
 *
 * 依据 ui-redesign.md §2.7：**不要自己猜按钮宽度**。
 *   ① CSS 兜底 `--wco-w: 138px`
 *   ② 首选 `navigator.windowControlsOverlay.getTitleBarAreaRect()`（DIP 精确）
 *   ③ `geometrychange` 事件覆盖全屏切换 / 缩放变化 / RTL
 *   ④ 不可用时的取值见 `syncWco()` 的注释（本实现对"未启用 WCO"的场景取 0，
 *      避免在原生边框窗口下右侧留下一条 138px 的死区；这是对 §2.7 ④ 的一处登记偏离）
 */
import { currentRoute } from './router';

interface WcoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WcoApi {
  getTitleBarAreaRect?: () => WcoRect;
  addEventListener?: (type: 'geometrychange', listener: () => void) => void;
  removeEventListener?: (type: 'geometrychange', listener: () => void) => void;
  visible?: boolean;
}

/** 三按钮实测总宽兜底（Windows 11 100% 缩放，46×3） */
const WCO_FALLBACK = 138;

export interface TitlebarHandle {
  /** 重新计算 --wco-w（也可由外部在主题/布局变化后主动调用） */
  syncWco(): void;
  /** 设置拖拽区标题 */
  setTitle(text: string): void;
  destroy(): void;
}

export function createTitlebar(titleEl: HTMLElement): TitlebarHandle {
  const nav = navigator as Navigator & { windowControlsOverlay?: WcoApi };
  const api = nav.windowControlsOverlay;

  function syncWco(): void {
    const rect = api?.getTitleBarAreaRect?.();
    let reserved: number;
    if (rect && rect.width > 0 && rect.width <= window.innerWidth) {
      // 权威来源：视口宽 − 系统可交互区宽
      reserved = Math.max(0, window.innerWidth - rect.width);
    } else if (api) {
      // WCO 已启用但拿不到矩形：用实测兜底值
      reserved = WCO_FALLBACK;
    } else {
      // 完全没有 WCO（普通浏览器预览，或主进程尚未启用 titleBarOverlay）：
      // 不预留右侧空间，避免出现"点不到任何东西"的死区
      reserved = 0;
    }
    document.documentElement.style.setProperty('--wco-w', `${Math.round(reserved)}px`);
  }

  const onResize = (): void => syncWco();

  syncWco();
  window.addEventListener('resize', onResize);
  api?.addEventListener?.('geometrychange', syncWco);

  const onBlur = (): void => document.body.classList.add('is-blurred');
  const onFocus = (): void => document.body.classList.remove('is-blurred');
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);

  return {
    syncWco,
    setTitle(text: string): void {
      titleEl.textContent = text;
      titleEl.title = text;
    },
    destroy(): void {
      window.removeEventListener('resize', onResize);
      api?.removeEventListener?.('geometrychange', syncWco);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    },
  };
}

/** 由当前路由与选中实例拼出拖拽区标题（§2.6）。 */
export function routeTitle(instanceName: string | null, viewLabel: string): string {
  const route = currentRoute();
  if (route.name === 'detail' && instanceName) return `${instanceName} · ${viewLabel}`;
  return `WhalesLauncher · ${viewLabel}`;
}
