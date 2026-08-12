<script lang="ts">
  import { onMount } from 'svelte';
  import { session, loginHref, currentDestination } from '$lib/session';
  type User = { id: string; name: string; email: string; role: string | null; banned: boolean };
  type Library = { id: string; displayName: string };
  type DirectoryPage = { items: User[]; nextCursor: string | null };
  let users: User[] = [], libraries: Library[] = [], selected: User | null = null;
  let q = '', libraryId = '', cursor: string | null = null, loading = false, message = '', error = '';
  let mounted = false, generation = 0, activeRequest: AbortController | null = null, libraryRequest: AbortController | null = null, loadingPage = false, started = false, sessionIdentity = '';
  const mutationRequests = new Set<AbortController>();
  function current(requestIdentity: string, requestGeneration: number) {
    return mounted && requestIdentity === sessionIdentity && requestGeneration === generation && $session.user?.role === 'admin';
  }

  function resetForSessionChange(identity: string) {
    if (identity === sessionIdentity) return;
    sessionIdentity = identity; generation++; activeRequest?.abort(); libraryRequest?.abort(); for (const request of mutationRequests) request.abort(); mutationRequests.clear();
    users = []; libraries = []; selected = null; cursor = null; q = ''; libraryId = '';
    loading = false; loadingPage = false; message = ''; error = ''; started = false;
  }

  async function load(reset = true) {
    if (!mounted || !$session.user || $session.user.role !== 'admin' || (loadingPage && !reset)) return;
    const snapshotQ = q.trim(), snapshotCursor = reset ? null : cursor, requestGeneration = ++generation;
    if (!reset && !snapshotCursor) return;
    loadingPage = true; loading = true; error = '';
    activeRequest?.abort(); const controller = new AbortController(); activeRequest = controller;
    const params = new URLSearchParams({ limit: '30' });
    if (snapshotQ) params.set('q', snapshotQ); if (snapshotCursor) params.set('cursor', snapshotCursor);
    try {
      const response = await fetch(`/api/admin/users?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 404 ? 'not_found' : 'request_failed');
      const body = await response.json() as DirectoryPage;
      if (!mounted || requestGeneration !== generation) return;
      users = reset ? body.items : [...users, ...body.items]; cursor = body.nextCursor;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (!mounted || requestGeneration !== generation) return;
      error = e instanceof Error && e.message === 'not_found' ? '管理者のみ利用できます。' : 'ユーザー一覧を読み込めませんでした。';
    } finally { if (requestGeneration === generation) { loading = false; loadingPage = false; } }
  }
  async function loadLibraries() {
    if (!mounted || !$session.user || $session.user.role !== 'admin') return;
    const requestIdentity = sessionIdentity, requestGeneration = generation;
    const controller = new AbortController(); libraryRequest?.abort(); libraryRequest = controller;
    try { const response = await fetch('/api/catalog/libraries', { signal: controller.signal }); if (response.ok && current(requestIdentity, requestGeneration)) libraries = (await response.json()).items; }
    catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError') && current(requestIdentity, requestGeneration)) error = 'ライブラリを読み込めませんでした。'; }
  }
  async function changeAccess(action: 'grant' | 'revoke') {
    if (!selected || !libraryId || !$session.user || $session.user.role !== 'admin') return;
    if (action === 'revoke' && !confirm(`「${selected.name}」のライブラリアクセスを取り消しますか？`)) return;
    const requestIdentity = sessionIdentity, requestGeneration = ++generation, controller = new AbortController(); mutationRequests.add(controller);
    message = ''; error = '';
    try {
      const response = await fetch(`/api/admin/library-access/${encodeURIComponent(selected.id)}/${encodeURIComponent(libraryId)}`, { method: action === 'grant' ? 'PUT' : 'DELETE', signal: controller.signal });
      if (!current(requestIdentity, requestGeneration)) return;
      if (!response.ok) { error = 'アクセス権を変更できませんでした。'; return; }
      message = action === 'grant' ? 'アクセスを付与しました。' : 'アクセスを取り消しました。';
    } catch (caught) { if (!(caught instanceof DOMException && caught.name === 'AbortError') && current(requestIdentity, requestGeneration)) error = 'アクセス権を変更できませんでした。'; } finally { mutationRequests.delete(controller); }
  }
  async function permanentlyDelete() {
    if (!selected || !$session.user || $session.user.role !== 'admin') return;
    if (selected.id === $session.user.id) { error = '自分自身は削除できません。'; return; }
    const subject = selected;
    const confirmation = prompt(`完全削除を確認するには「${subject.name}」と入力してください。`);
    if (confirmation !== subject.name) return;
    const requestIdentity = sessionIdentity, requestGeneration = ++generation, controller = new AbortController(); mutationRequests.add(controller);
    message = ''; error = '';
    let response: Response;
    try {
      response = await fetch(`/api/admin/users/${encodeURIComponent(selected.id)}/user-state`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal,
      });
    } catch (caught) {
      mutationRequests.delete(controller);
      if (!(caught instanceof DOMException && caught.name === 'AbortError') && current(requestIdentity, requestGeneration)) error = 'ユーザーを完全削除できませんでした。';
      return;
    }
    if (!current(requestIdentity, requestGeneration)) { mutationRequests.delete(controller); return; }
    if (!response.ok) { mutationRequests.delete(controller); error = response.status === 400 ? 'このユーザーは削除できません。' : 'ユーザーを完全削除できませんでした。'; return; }
    message = 'ユーザーを完全削除しました。';
    mutationRequests.delete(controller);
    if (selected?.id !== subject.id) return;
    selected = null; cursor = null; generation++; void load();
  }
  $: {
    const identity = $session.loading ? 'loading' : $session.user ? `${$session.user.id ?? ''}:${$session.user.role ?? ''}` : 'anonymous';
    if (mounted) resetForSessionChange(identity);
    if (mounted && !$session.loading && $session.user?.role === 'admin' && !started) { started = true; void load(); void loadLibraries(); }
  }
  onMount(() => { mounted = true; return () => { mounted = false; generation++; activeRequest?.abort(); libraryRequest?.abort(); for (const request of mutationRequests) request.abort(); mutationRequests.clear(); }; });
</script>

<svelte:head><title>gutter — 管理者設定</title></svelte:head>
{#if $session.loading}<p aria-live="polite">セッションを確認中…</p>
{:else if !$session.user}<section aria-labelledby="admin-title"><h1 id="admin-title">管理者設定</h1><p>管理者としてログインしてください。</p><a href={loginHref(currentDestination())}>ログイン</a></section>
{:else if $session.user.role !== 'admin'}<section aria-labelledby="admin-title"><h1 id="admin-title">管理者設定</h1><p role="alert">管理者のみ利用できます。</p></section>
{:else}<section aria-labelledby="admin-title"><h1 id="admin-title">管理者設定</h1>
  <form onsubmit={(event) => { event.preventDefault(); cursor = null; generation++; void load(); }}><label>ユーザー検索 <input bind:value={q} maxlength="256" placeholder="名前またはメールアドレス" /></label><button>検索</button></form>
  {#if loading}<p aria-live="polite">読み込み中…</p>{:else if error}<p role="alert">{error}</p>{:else if users.length === 0}<p>ユーザーが見つかりません。</p>{:else}<ul aria-label="ユーザー一覧">{#each users as user}<li><button class:selected={selected?.id === user.id} type="button" onclick={() => selected = user}><strong>{user.name}</strong><span>{user.email} · {user.role ?? 'user'}{user.banned ? ' · banned' : ''}</span></button></li>{/each}</ul>{#if cursor}<button type="button" disabled={loadingPage} onclick={() => void load(false)}>さらに読み込む</button>{/if}{/if}
  {#if selected}<section aria-labelledby="access-title"><h2 id="access-title">{selected.name} のライブラリアクセス</h2><label>ライブラリ <select bind:value={libraryId}><option value="">選択してください</option>{#each libraries as library}<option value={library.id}>{library.displayName}</option>{/each}</select></label><button disabled={!libraryId} onclick={() => void changeAccess('grant')}>付与</button><button disabled={!libraryId} onclick={() => void changeAccess('revoke')}>取り消し</button><div><h3>プライバシー</h3><p>完全削除すると、このユーザーの読書状態、認証情報、アクセス権を削除します。取り消せません。</p><button type="button" onclick={() => void permanentlyDelete()}>ユーザーを完全削除</button></div></section>{/if}
  <section aria-labelledby="admin-unavailable-title"><h2 id="admin-unavailable-title">利用できない管理機能</h2><ul><li>ユーザーの作成・停止・全セッションの取り消し</li><li>ライブラリルートの追加・編集・削除（Issue #3）</li><li>認証シークレットや監査履歴の変更</li></ul></section>
  {#if message}<p role="status">{message}</p>{/if}
</section>{/if}
