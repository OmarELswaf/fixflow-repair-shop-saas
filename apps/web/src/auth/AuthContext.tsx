import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  clearTenantCaches,
  fetchMe,
  getAccessToken,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  selectTenant as apiSelectTenant,
  setAccessToken,
  tryRefresh,
  type LoginResponse,
  type MeResponse,
  type Membership,
  type TenantChoice,
  type TenantContext,
  type User,
} from '../api/client';
import {
  clearCurrentPendingOps,
  clearPendingOps,
  setPendingTenant,
  setPendingUser,
} from '../api/pendingOps';

export interface AuthState {
  user: User | null;
  memberships: Membership[];
  tenantContext: TenantContext | null;
  /** Tenants offered when the user must pick one (multi-tenant login). */
  tenantChoices: TenantChoice[];
  needsTenantSelection: boolean;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResponse>;
  register: (input: {
    email: string;
    password: string;
    name?: string;
    tenantName: string;
    branchName: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  selectTenant: (tenantId: string) => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider.');
  return ctx;
}

function applyMe(me: MeResponse): {
  user: User;
  memberships: Membership[];
  tenantContext: TenantContext | null;
} {
  return { user: me.user, memberships: me.memberships, tenantContext: me.tenantContext };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantContext, setTenantContext] = useState<TenantContext | null>(null);
  const [tenantChoices, setTenantChoices] = useState<TenantChoice[]>([]);
  const [needsTenantSelection, setNeedsTenantSelection] = useState(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const clearAuthState = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setMemberships([]);
    setTenantContext(null);
    setTenantChoices([]);
    setNeedsTenantSelection(false);
    clearTenantCaches();
    // Durable pending stock ops are user-scoped: logout drops all of
    // the current user's records, across tenants.
    clearCurrentPendingOps();
  }, []);

  const pendingScopeRef = useRef<{ userId: string | null; tenantId: string | null }>({
    userId: null,
    tenantId: null,
  });
  useEffect(() => {
    const nextUser = user?.id ?? null;
    const nextTenant = tenantContext?.tenantId ?? null;
    const previous = pendingScopeRef.current;
    // Only clear a previous tenant when the same user switches tenants.
    // Never delete another account's records while adopting a new login.
    if (
      previous.userId &&
      previous.userId === nextUser &&
      previous.tenantId &&
      previous.tenantId !== nextTenant
    )
      clearPendingOps(previous.tenantId, previous.userId);
    setPendingUser(nextUser);
    setPendingTenant(nextTenant);
    pendingScopeRef.current = { userId: nextUser, tenantId: nextTenant };
  }, [user?.id, tenantContext?.tenantId]);

  const refreshMe = useCallback(async () => {
    const me = await fetchMe();
    if (!mounted.current) return;
    const applied = applyMe(me);
    setUser(applied.user);
    setMemberships(applied.memberships);
    setTenantContext(applied.tenantContext);
    setNeedsTenantSelection(applied.tenantContext === null && applied.memberships.length > 1);
    // Tenant choices are always offered to multi-tenant users, not
    // only before the first selection: a user already working in one
    // shop can switch to another from the shell without logging out.
    if (applied.memberships.length > 1) {
      setTenantChoices(
        applied.memberships.map((m) => ({
          tenantId: m.tenantId,
          role: m.role,
          name: m.tenantName ?? undefined,
        })),
      );
    } else {
      setTenantChoices([]);
    }
  }, []);

  // On mount: try the HttpOnly refresh cookie once, then load /me.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ok = await tryRefresh();
        if (!ok || cancelled) return;
        await refreshMe();
      } catch {
        if (!cancelled) clearAuthState();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshMe, clearAuthState]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResponse> => {
      const res = await apiLogin(email, password);
      if (res.requiresTenantSelection) {
        setUser(res.user);
        setTenantChoices(res.tenants ?? []);
        setNeedsTenantSelection(true);
        setTenantContext(null);
        setMemberships([]);
        return res;
      }
      await refreshMe();
      return res;
    },
    [refreshMe],
  );

  const register = useCallback(
    async (input: {
      email: string;
      password: string;
      name?: string;
      tenantName: string;
      branchName: string;
    }): Promise<void> => {
      await apiRegister(input);
      await refreshMe();
    },
    [refreshMe],
  );

  const selectTenant = useCallback(
    async (tenantId: string): Promise<void> => {
      await apiSelectTenant(tenantId);
      clearTenantCaches();
      await refreshMe();
    },
    [refreshMe],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiLogout();
    } finally {
      clearAuthState();
      navigate('/login');
    }
  }, [clearAuthState, navigate]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      memberships,
      tenantContext,
      tenantChoices,
      needsTenantSelection,
      isAuthenticated: user !== null && getAccessToken() !== null,
      loading,
      login,
      register,
      logout,
      selectTenant,
      refreshMe,
    }),
    [
      user,
      memberships,
      tenantContext,
      tenantChoices,
      needsTenantSelection,
      loading,
      login,
      register,
      logout,
      selectTenant,
      refreshMe,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
