import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  CircularProgress,
  List,
  ListItem,
  ListItemText,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { ApiError, fetchTeam, type TeamMember } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { roleLabel, useLanguage, useStrings } from '../i18n';
import { PageContainer, SectionCard } from '../components/SectionCard';

/**
 * Read-only team view for the owner: branches and staff memberships
 * with their roles and branch scopes. No invitations, role changes or
 * branch creation here — this page only shows existing scopes.
 */
export default function TeamPage() {
  const t = useStrings();
  const lang = useLanguage();
  const { tenantContext } = useAuth();
  const canAdmin = tenantContext?.permissions.includes('admin') ?? false;

  const team = useQuery({
    queryKey: ['team'],
    queryFn: fetchTeam,
    enabled: canAdmin,
    retry: false,
  });

  if (!canAdmin) {
    return (
      <PageContainer>
        <Alert severity="warning" role="alert">
          {t.noAccess}
        </Alert>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
        {t.teamTitle}
      </Typography>
      {team.isLoading && <CircularProgress aria-label="loading" />}
      {team.isError && (
        <Alert severity="error" sx={{ mb: 2 }} role="alert">
          {team.error instanceof ApiError ? team.error.message : t.networkError}
        </Alert>
      )}
      {team.data && (
        <>
          <SectionCard title={t.branches}>
            <List sx={{ py: 0 }}>
              {team.data.branches.map((branch) => (
                <ListItem key={branch.id} divider sx={{ px: 0 }}>
                  <ListItemText primary={branch.name} />
                </ListItem>
              ))}
            </List>
          </SectionCard>

          <SectionCard title={t.members}>
            {team.data.members.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {t.noMembers}
              </Typography>
            )}
            {team.data.members.length > 0 && (
              <Box sx={{ display: { xs: 'grid', md: 'none' }, gap: 2 }}>
                {team.data.members.map((member) => (
                  <Box
                    key={member.userId}
                    sx={{
                      border: 1,
                      borderColor: 'divider',
                      p: 2,
                      borderRadius: 3,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    <Typography sx={{ fontWeight: 700 }}>{member.name ?? member.email}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      <bdi>{member.email}</bdi>
                    </Typography>
                    <Typography variant="body2">
                      {t.role}: {roleLabel(lang, member.role)}
                    </Typography>
                    <Typography variant="body2">
                      {t.branches}: {member.branchNames.join(', ')}
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}
            {team.data.members.length > 0 && (
              <TableContainer sx={{ display: { xs: 'none', md: 'block' } }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{t.memberName}</TableCell>
                      <TableCell>{t.email}</TableCell>
                      <TableCell>{t.role}</TableCell>
                      <TableCell>{t.branches}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {team.data.members.map((member: TeamMember) => (
                      <TableRow key={member.userId}>
                        <TableCell>{member.name ?? member.email}</TableCell>
                        <TableCell>
                          <bdi>{member.email}</bdi>
                        </TableCell>
                        <TableCell>{roleLabel(lang, member.role)}</TableCell>
                        <TableCell>{member.branchNames.join(', ')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </SectionCard>
        </>
      )}
    </PageContainer>
  );
}
