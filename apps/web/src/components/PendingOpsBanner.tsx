import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Button, Link } from '@mui/material';
import { fetchMovementsByOperationKey, queryClient } from '../api/client';
import {
  loadPendingOps,
  reconcilePendingOps,
  removePendingOp,
  subscribePendingOps,
  type PendingOp,
} from '../api/pendingOps';
import { useAuth } from '../auth/AuthContext';
import { useStrings } from '../i18n';

type NoticeStatus = 'completed' | 'unknown';

interface Notice {
  op: PendingOp;
  status: NoticeStatus;
}

/**
 * Reconciles durable pending stock operations once, after auth and
 * tenant selection. A movement with the operation key means the write
 * completed; otherwise the outcome is unknown and the record is kept
 * until the user confirms they checked the ledger. Nothing here ever
 * re-submits an operation.
 *
 * Records are user-scoped: only the current user's pending ops are
 * ever shown or reconciled. Changes made by other tabs (a pending op
 * recorded, completed or dismissed elsewhere, or a stock write
 * completing) arrive as storage events and refresh this tab; a
 * stock-changed broadcast invalidates the stock/repair queries.
 */
export default function PendingOpsBanner() {
  const t = useStrings();
  const { tenantContext, user } = useAuth();
  const tenantId = tenantContext?.tenantId ?? null;
  const userId = user?.id ?? null;
  const scope = userId && tenantId ? `${userId}:${tenantId}` : null;
  const [notices, setNotices] = useState<Notice[]>([]);
  const [noticeScope, setNoticeScope] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let rerun = false;
    setNotices([]);
    setNoticeScope(scope);
    if (!scope || !tenantId || !userId) return;
    const run = async () => {
      if (cancelled) return;
      if (inFlight) {
        rerun = true;
        return;
      }
      inFlight = true;
      try {
        const result = await reconcilePendingOps(
          tenantId,
          userId,
          fetchMovementsByOperationKey,
          () => !cancelled,
        );
        if (cancelled) return;
        setNotices((existing) => [
          ...existing.filter(
            (n) =>
              n.status === 'completed' &&
              !result.completed.some((op) => op.operationKey === n.op.operationKey),
          ),
          ...result.completed.map((op) => ({ op, status: 'completed' as const })),
          ...result.unknown.map((op) => ({ op, status: 'unknown' as const })),
        ]);
      } finally {
        inFlight = false;
        if (rerun && !cancelled) {
          rerun = false;
          void run();
        }
      }
    };
    if (loadPendingOps(tenantId, userId).length) void run();
    const unsubscribe = subscribePendingOps(userId, tenantId, (event) => {
      if (event.type === 'pending-changed') void run();
      else void queryClient.invalidateQueries();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [scope, tenantId, userId]);

  const dismiss = (notice: Notice) => {
    if (notice.status === 'unknown' && tenantId && userId) {
      // "I have checked": the user confirmed the ledger; drop the record.
      removePendingOp(tenantId, notice.op.operationKey, userId);
    }
    setNotices((current) => current.filter((n) => n.op.operationKey !== notice.op.operationKey));
  };

  if (notices.length === 0 || noticeScope !== scope) return null;

  return (
    <Box sx={{ px: 2, pt: 1 }}>
      {notices.map((notice) => (
        <Alert
          key={notice.op.operationKey}
          severity={notice.status === 'completed' ? 'success' : 'warning'}
          role="alert"
          sx={{ mb: 1 }}
          action={
            <Button color="inherit" size="small" onClick={() => dismiss(notice)}>
              {notice.status === 'unknown' ? t.pendingOpChecked : t.close}
            </Button>
          }
        >
          {notice.status === 'completed' ? t.pendingOpCompleted : t.pendingOpUnknown}{' '}
          {notice.op.repairOrderId ? (
            <Link component={RouterLink} to={`/repairs/${notice.op.repairOrderId}`}>
              {t.repairLink} <bdi>{notice.op.repairOrderId}</bdi>
            </Link>
          ) : (
            <Link component={RouterLink} to="/stock">
              {t.stock}
            </Link>
          )}
        </Alert>
      ))}
    </Box>
  );
}
