const STORAGE_NS = "nameforme:v1";

export const FAVORITES_KEY = `${STORAGE_NS}:favorites`;

/** 收藏列表变更（同页多组件同步） */
export const FAVORITES_CHANGED_EVENT = "nameforme-favorites-changed";

/** 搜索会话列表变更（历史页与搜索页同步） */
export const SEARCH_SESSIONS_CHANGED_EVENT = "nameforme-search-sessions-changed";

export const SEARCH_SESSIONS_KEY = `${STORAGE_NS}:searchSessions`;
