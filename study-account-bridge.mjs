/** Synchronous study model over an in-memory draft, with serialized server CAS.
 * No localStorage, credentials, anonymous import or client-side entitlements.
 */
export function createStudyAccountBridge({client, model, initial, writable = true, onStatus = () => {}}) {
  if (!initial || !Number.isSafeInteger(initial.revision) || initial.revision < 0) throw Error('Estado da conta inválido.');
  const clone = value => JSON.parse(JSON.stringify(value));
  const first = initial.data && Object.keys(initial.data).length ? model.validateState(clone(initial.data)) : model.emptyState();
  let raw = JSON.stringify(first), remoteRevision = initial.revision, generation = 0, savedGeneration = 0;
  let pending = null, pumping = null, frozen = false, disposed = false, phase = 'saved', error = null;
  const memory = {getItem: () => raw, setItem: (_, value) => {raw = value;}};
  const local = model.createStore({storage: memory});
  const snapshot = () => ({phase, pending: generation !== savedGeneration, frozen, remoteRevision, error});
  const notify = () => onStatus(snapshot());
  const result = value => ({...value, persisted: !disposed && !frozen && generation === savedGeneration,
    warning: frozen ? error : value.warning});
  async function drain() {
    while (pending && !frozen && !disposed) {
      const item = pending; pending = null;
      try {
        const response = await client.saveState('study', remoteRevision, item.data);
        if (disposed) return;
        if (!response || response.revision !== remoteRevision + 1 || JSON.stringify(response.data) !== JSON.stringify(item.data)) throw Error('Invalid server acknowledgement');
        remoteRevision = response.revision; savedGeneration = item.generation;
        phase = pending ? 'saving' : 'saved'; notify();
      } catch (failure) {
        if (disposed) return;
        frozen = true;
        const conflict = failure.message === 'State changed; reload before saving';
        phase = conflict ? 'conflict' : 'error';
        error = conflict ? 'O progresso mudou em outra aba ou aparelho. Recarregue a versão salva antes de continuar.'
          : 'Não consegui confirmar a gravação. Mantenha esta tela aberta e confira a conexão antes de recarregar.';
        notify(); return;
      }
    }
  }
  function kick() {
    if (!pumping && !frozen && !disposed && pending) {
      pumping = drain().finally(() => {pumping = null; if (pending && !frozen && !disposed) kick();});
    }
  }
  const store = {
    key: 'account-memory-only',
    read() {return result(local.read());},
    transact(mutator) {
      if (disposed || frozen || !writable) return {...store.read(), ok: false, warning: error || 'Esta conta não tem acesso ao estudo.'};
      const change = local.transact(mutator);
      if (!change.ok) return result(change);
      generation++; pending = {generation, data: clone(change.state)}; phase = 'saving'; notify(); kick();
      return result(change);
    },
  };
  return {
    store, status: snapshot,
    async flush() {kick(); while (pumping) await pumping; return !disposed && !frozen && generation === savedGeneration;},
    dispose() {disposed = true; frozen = true; pending = null; raw = JSON.stringify(model.emptyState()); phase = 'signed-out'; notify();},
  };
}
