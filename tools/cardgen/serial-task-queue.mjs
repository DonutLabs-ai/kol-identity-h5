export function createSerialTaskQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    // Scheduling continues after failure; the caller still receives the original rejection.
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
