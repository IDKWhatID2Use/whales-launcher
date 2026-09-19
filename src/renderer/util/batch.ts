/** 微批处理：把同一轮事件循环内的多次刷新合并为一次渲染。 */

export function createBatcher(run: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      run();
    }, 0);
  };
}
