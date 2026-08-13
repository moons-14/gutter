<script lang="ts">
  import { onMount } from 'svelte';
  import { loginHref, currentDestination, session, signOut } from '$lib/session';

  type Collection = { id: string; name: string; createdAt?: string; updatedAt?: string };
  type CollectionPage = { items: Collection[]; nextCursor: string | null };
  let mounted = false;
  let identity = '';
  let collections: Collection[] = [];
  let collectionsLoaded = false;
  let cursor: string | null = null;
  let collectionName = '';
  let loading = false;
  let loadingMore = false;
  let exporting = false;
  let message = '';
  let error = '';
  let collectionError = '';
  let sessionGeneration = 0, collectionGeneration = 0, exportGeneration = 0;
  const collectionRequests = new Set<AbortController>(), operationRequests = new Set<AbortController>();

  function requestForCurrent(set: Set<AbortController>) {
    const controller = new AbortController();
    set.add(controller);
    return controller;
  }
  function sessionIsCurrent(requestIdentity: string, requestGeneration: number) {
    return mounted && requestIdentity === identity && requestGeneration === sessionGeneration && Boolean($session.user?.id);
  }
  function collectionIsCurrent(requestIdentity: string, requestSession: number, requestGeneration: number) {
    return sessionIsCurrent(requestIdentity, requestSession) && requestGeneration === collectionGeneration;
  }

  function reset(nextIdentity: string) {
    if (identity === nextIdentity) return;
    identity = nextIdentity;
    sessionGeneration++;
    for (const request of collectionRequests) request.abort();
    for (const request of operationRequests) request.abort();
    collectionRequests.clear(); operationRequests.clear();
    collections = [];
    collectionsLoaded = false;
    cursor = null;
    message = '';
    error = '';
    collectionError = '';
    loading = false;
    loadingMore = false;
    exporting = false;
  }

  async function loadCollections(resetPage = true) {
    if (!mounted || !$session.user?.id || (loadingMore && !resetPage)) return;
    const requestIdentity = identity;
    const requestSession = sessionGeneration;
    const requestGeneration = ++collectionGeneration;
    const requestCursor = resetPage ? null : cursor;
    if (!resetPage && !requestCursor) return;
    const controller = requestForCurrent(collectionRequests);
    if (resetPage) loading = true; else loadingMore = true;
    error = '';
    collectionError = '';
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (requestCursor) params.set('cursor', requestCursor);
      const response = await fetch(`/api/user-state/collections?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error('collections_failed');
      const body = (await response.json()) as CollectionPage;
      if (!collectionIsCurrent(requestIdentity, requestSession, requestGeneration)) return;
      collections = resetPage ? body.items : [...collections, ...body.items];
      cursor = body.nextCursor;
      collectionsLoaded = true;
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (collectionIsCurrent(requestIdentity, requestSession, requestGeneration)) {
        collectionsLoaded = true;
        collectionError = 'コレクションを読み込めませんでした。';
      }
    } finally {
      collectionRequests.delete(controller);
      if (collectionIsCurrent(requestIdentity, requestSession, requestGeneration)) { loading = false; loadingMore = false; }
    }
  }

  function retryCollections() {
    collectionsLoaded = false;
    collectionError = '';
    void loadCollections();
  }

  async function createCollection() {
    const name = collectionName.trim();
    if (!name || !$session.user?.id) return;
    const requestIdentity = identity, requestSession = sessionGeneration, controller = requestForCurrent(operationRequests);
    message = ''; error = '';
    try {
      const response = await fetch('/api/user-state/collections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }), signal: controller.signal,
      });
      if (!response.ok) { if (sessionIsCurrent(requestIdentity, requestSession)) error = 'コレクションを作成できませんでした。'; return; }
      if (!sessionIsCurrent(requestIdentity, requestSession)) return;
      collectionName = '';
      message = 'コレクションを作成しました。';
      await loadCollections();
    } catch (caught) { if (!(caught instanceof DOMException && caught.name === 'AbortError') && sessionIsCurrent(requestIdentity, requestSession)) error = 'コレクションを作成できませんでした.'; }
    finally { operationRequests.delete(controller); }
  }

  async function deleteCollection(collection: Collection) {
    if (!confirm(`「${collection.name}」を削除しますか？この操作は取り消せません。`)) return;
    const requestIdentity = identity, requestSession = sessionGeneration, controller = requestForCurrent(operationRequests);
    message = ''; error = '';
    try {
      const response = await fetch(`/api/user-state/collections/${encodeURIComponent(collection.id)}`, { method: 'DELETE', signal: controller.signal });
      if (!response.ok) { if (sessionIsCurrent(requestIdentity, requestSession)) error = 'コレクションを削除できませんでした。'; return; }
      if (!sessionIsCurrent(requestIdentity, requestSession)) return;
      message = 'コレクションを削除しました.';
      await loadCollections();
    } catch (caught) { if (!(caught instanceof DOMException && caught.name === 'AbortError') && sessionIsCurrent(requestIdentity, requestSession)) error = 'コレクションを削除できませんでした。'; }
    finally { operationRequests.delete(controller); }
  }

  async function exportState() {
    if (!$session.user?.id) return;
    const requestIdentity = identity, requestSession = sessionGeneration, requestGeneration = ++exportGeneration, controller = requestForCurrent(operationRequests);
    exporting = true; message = ''; error = '';
    try {
      const response = await fetch('/api/user-state/export', { signal: controller.signal });
      if (!response.ok) throw new Error('export_failed');
      const blob = await response.blob();
      if (!sessionIsCurrent(requestIdentity, requestSession) || requestGeneration !== exportGeneration) return;
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url; link.download = 'gutter-user-state.json'; link.click();
      } finally { URL.revokeObjectURL(url); }
      message = 'データを書き出しました。';
    } catch (caught) { if (!(caught instanceof DOMException && caught.name === 'AbortError') && sessionIsCurrent(requestIdentity, requestSession) && requestGeneration === exportGeneration) error = 'データを書き出せませんでした。'; }
    finally { operationRequests.delete(controller); if (sessionIsCurrent(requestIdentity, requestSession) && requestGeneration === exportGeneration) exporting = false; }
  }

  async function handleSignOut() {
    const requestIdentity = identity, requestSession = sessionGeneration;
    try { await signOut(); if (sessionIsCurrent(requestIdentity, requestSession)) message = 'ログアウトしました。'; }
    catch { if (sessionIsCurrent(requestIdentity, requestSession)) error = 'ログアウトに失敗しました。'; }
  }

  $: {
    const next = $session.loading ? 'loading' : $session.user ? `${$session.user.id ?? ''}:${$session.user.role ?? ''}` : 'anonymous';
    if (mounted) reset(next);
    if (mounted && !$session.loading && $session.user && identity === next && !collectionsLoaded && !loading) void loadCollections();
  }
  onMount(() => { mounted = true; return () => { mounted = false; sessionGeneration++; for (const request of collectionRequests) request.abort(); for (const request of operationRequests) request.abort(); collectionRequests.clear(); operationRequests.clear(); }; });
</script>

<svelte:head><title>gutter — 設定</title></svelte:head>
{#if $session.loading}<p aria-live="polite">セッションを確認中…</p>
{:else if !$session.user}<section aria-labelledby="settings-title"><h1 id="settings-title">設定</h1><p>設定を見るにはログインしてください。</p><a href={loginHref(currentDestination())}>ログイン</a></section>
{:else}<h1 id="settings-title">設定</h1>
  {#if message}<p role="status" aria-live="polite">{message}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <section aria-labelledby="account-title"><h2 id="account-title">アカウント</h2>
    <dl><dt>表示名</dt><dd>{ $session.user.name || '未設定' }</dd><dt>メールアドレス</dt><dd>{ $session.user.email || '未設定' }</dd><dt>権限</dt><dd>{ $session.user.role || 'user' }</dd></dl>
    <p>プロフィール、パスワード、パスキー、二要素認証の変更は、現在利用できる認証サービスの設定から行ってください。追加の設定操作は未提供です。</p>
    <button type="button" onclick={() => void handleSignOut()}>ログアウト</button>
  </section>
  <section aria-labelledby="privacy-title"><h2 id="privacy-title">プライバシーとデータ</h2>
    <p>あなたの読書状態、コレクション、ブックマークをJSONで書き出せます。</p>
    <button type="button" disabled={exporting} onclick={() => void exportState()}>{exporting ? '書き出し中…' : 'データを書き出す'}</button>
  </section>
  <section aria-labelledby="collections-title"><h2 id="collections-title">コレクション</h2>
    <form onsubmit={(event) => { event.preventDefault(); void createCollection(); }}><label for="collection-name">新しいコレクション名</label><input id="collection-name" bind:value={collectionName} maxlength="128" required /><button type="submit">作成</button></form>
    {#if loading}<p aria-live="polite">読み込み中…</p>{:else if collectionError}<p role="alert">{collectionError}</p><button type="button" onclick={retryCollections}>再試行</button>{:else if collections.length === 0}<p>コレクションはありません。</p>{:else}<ul aria-label="コレクション一覧">{#each collections as collection}<li><span>{collection.name}</span><button type="button" onclick={() => void deleteCollection(collection)}>削除</button></li>{/each}</ul>{/if}
    {#if cursor}<button type="button" disabled={loadingMore} onclick={() => void loadCollections(false)}>さらに読み込む</button>{/if}
  </section>
  <section aria-labelledby="unavailable-title"><h2 id="unavailable-title">現在利用できない管理機能</h2><ul><li>ライブラリルートの追加・編集・削除（Issue #3）</li><li>ユーザー作成、停止、全セッションの取り消し</li><li>認証シークレット、ブートストラップ、監査履歴の変更</li></ul></section>
{/if}
