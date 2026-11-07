// 控制器内的串行变更队列（隧道：ensure / restartControlled；代理：ensure / handoff）。
// 串行队列而非布尔旗标：进行中的受控动作期间到来的保活 ensure 顺延执行而不是被丢掉
// （下一拍保活照常收敛），也不会一边 stop 一边被正常循环重复 spawn。
// 前一个动作失败不阻断后一个；每个动作的结果/异常原样返回给它自己的调用方。
export function createMutationQueue() {
  let mutationChain = Promise.resolve();
  return function serializeMutation(fn) {
    const run = mutationChain.then(fn, fn);
    mutationChain = run.then(() => {}, () => {});
    return run;
  };
}
