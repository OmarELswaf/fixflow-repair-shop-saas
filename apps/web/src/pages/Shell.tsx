import { useState } from 'react';
import { Outlet, Link as RouterLink, useLocation, useNavigate } from 'react-router-dom';
import {
  AppBar,
  Box,
  BottomNavigation,
  BottomNavigationAction,
  Button,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AssessmentIcon from '@mui/icons-material/Assessment';
import BuildIcon from '@mui/icons-material/Build';
import CategoryIcon from '@mui/icons-material/Category';
import CloseIcon from '@mui/icons-material/Close';
import GroupIcon from '@mui/icons-material/Group';
import HomeIcon from '@mui/icons-material/Home';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import PeopleIcon from '@mui/icons-material/People';
import PublicIcon from '@mui/icons-material/Public';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import TranslateIcon from '@mui/icons-material/Translate';
import PendingOpsBanner from '../components/PendingOpsBanner';
import { useAuth } from '../auth/AuthContext';
import { roleLabel, useStrings, type Language } from '../i18n';

const SIDEBAR_WIDTH = 272;

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  show: boolean;
  exact?: boolean;
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === '/';
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export default function Shell({ lang, onLanguage }: { lang: Language; onLanguage: () => void }) {
  const t = useStrings();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const { tenantContext, memberships, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleLogout = () => {
    void logout().then(() => navigate('/login'));
  };

  const branchIds = tenantContext?.branchIds ?? memberships.flatMap((m) => m.branchIds);
  const role = tenantContext?.role ?? memberships[0]?.role ?? '';
  const canReadInventory = tenantContext?.permissions.includes('inventory:read') ?? false;
  const canReadReports = tenantContext?.permissions.includes('report:read') ?? false;
  const canAdmin = tenantContext?.permissions.includes('admin') ?? false;
  const selectedMembership =
    memberships.find((m) => m.tenantId === tenantContext?.tenantId) ?? memberships[0];
  const branchLabel = (id: string) =>
    selectedMembership?.branches?.find((b) => b.id === id)?.name ?? id;
  const shopName = tenantContext?.tenantName ?? '';

  const navItems: NavItem[] = [
    { to: '/', label: t.home, icon: <HomeIcon />, show: true, exact: true },
    { to: '/repairs', label: t.repairs, icon: <BuildIcon />, show: true },
    { to: '/customers', label: t.customers, icon: <PeopleIcon />, show: true },
    { to: '/parts', label: t.parts, icon: <CategoryIcon />, show: canReadInventory },
    { to: '/stock', label: t.stock, icon: <Inventory2Icon />, show: canReadInventory },
    { to: '/reports', label: t.reports, icon: <AssessmentIcon />, show: canReadReports },
    { to: '/team', label: t.team, icon: <GroupIcon />, show: canAdmin },
    { to: '/settings/public-profile', label: t.publicPage, icon: <PublicIcon />, show: canAdmin },
    { to: '/status', label: t.status, icon: <InfoOutlinedIcon />, show: true },
  ];
  const visibleNav = navItems.filter((item) => item.show);

  // Bottom navigation: the primary destinations only. Parts, team and
  // status live in the drawer.
  const bottomItems = visibleNav.filter((item) =>
    ['/', '/repairs', '/customers', '/stock', '/reports'].includes(item.to),
  );
  const bottomValue = bottomItems.findIndex((item) => isActive(location.pathname, item));

  const shopContext = (
    <Box sx={{ px: 2, py: 2 }}>
      <Typography variant="h6" component="p" sx={{ lineHeight: 1.3 }}>
        {t.appName}
      </Typography>
      {shopName && (
        <Typography variant="body1" sx={{ fontWeight: 700, mt: 0.5 }}>
          {shopName}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {role ? `${t.role}: ${roleLabel(lang, role)}` : ''}
        {branchIds.length > 0
          ? `${role ? ' · ' : ''}${t.branches}: ${branchIds.map(branchLabel).join(', ')}`
          : ''}
      </Typography>
    </Box>
  );

  const navList = (
    <List sx={{ px: 1, py: 1 }}>
      {visibleNav.map((item) => (
        <ListItemButton
          key={item.to}
          component={RouterLink}
          to={item.to}
          selected={isActive(location.pathname, item)}
          aria-current={isActive(location.pathname, item) ? 'page' : undefined}
          onClick={() => setDrawerOpen(false)}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
          <ListItemText primary={item.label} />
        </ListItemButton>
      ))}
    </List>
  );

  const accountActions = (
    <Box sx={{ px: 1, pb: 2, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {memberships.length > 1 && (
        <Button
          variant="outlined"
          component={RouterLink}
          to="/select-tenant"
          startIcon={<SwapHorizIcon />}
          onClick={() => setDrawerOpen(false)}
          sx={{ justifyContent: 'flex-start' }}
        >
          {t.switchTenant}
        </Button>
      )}
      <Button
        variant="text"
        onClick={onLanguage}
        aria-label="language-toggle"
        startIcon={<TranslateIcon />}
        sx={{ justifyContent: 'flex-start' }}
      >
        {t.language}
      </Button>
      <Button
        variant="text"
        onClick={handleLogout}
        startIcon={<LogoutIcon />}
        sx={{ justifyContent: 'flex-start' }}
      >
        {t.logout}
      </Button>
    </Box>
  );

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', md: 'row' },
        minHeight: '100vh',
      }}
    >
      {isDesktop ? (
        <Drawer
          variant="permanent"
          anchor={lang === 'ar' ? 'right' : 'left'}
          sx={{
            width: SIDEBAR_WIDTH,
            flexShrink: 0,
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': {
              width: SIDEBAR_WIDTH,
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              '@media print': { display: 'none' },
            },
          }}
        >
          {shopContext}
          <Divider />
          <Box sx={{ flexGrow: 1, overflowY: 'auto' }}>{navList}</Box>
          <Divider />
          {accountActions}
        </Drawer>
      ) : (
        <>
          <AppBar
            position="sticky"
            sx={{
              backgroundColor: 'background.paper',
              color: 'text.primary',
              boxShadow: 'none',
              borderBottom: 1,
              borderColor: 'divider',
              '@media print': { display: 'none' },
            }}
          >
            <Toolbar sx={{ minHeight: 56, px: 1, gap: 0.5 }}>
              <IconButton
                edge="start"
                color="inherit"
                aria-label={t.menu}
                onClick={() => setDrawerOpen(true)}
              >
                <MenuIcon />
              </IconButton>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography
                  variant="body1"
                  component="p"
                  sx={{ fontWeight: 700, lineHeight: 1.25 }}
                  noWrap
                >
                  {shopName || t.appName}
                </Typography>
                {shopName && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                    sx={{ display: 'block', lineHeight: 1.2 }}
                  >
                    {t.appName}
                  </Typography>
                )}
              </Box>
              <Button
                color="inherit"
                onClick={onLanguage}
                aria-label="language-toggle"
                sx={{ minWidth: 0, px: 1.5 }}
              >
                {t.language}
              </Button>
            </Toolbar>
          </AppBar>
          <Drawer
            variant="temporary"
            anchor={lang === 'ar' ? 'right' : 'left'}
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            ModalProps={{ keepMounted: false }}
            sx={{
              '& .MuiDrawer-paper': {
                width: 280,
                display: 'flex',
                flexDirection: 'column',
                '@media print': { display: 'none' },
              },
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                pe: 1,
              }}
            >
              <Box sx={{ flexGrow: 1 }}>{shopContext}</Box>
              <IconButton aria-label={t.close} onClick={() => setDrawerOpen(false)}>
                <CloseIcon />
              </IconButton>
            </Box>
            <Divider />
            <Box sx={{ flexGrow: 1, overflowY: 'auto' }}>{navList}</Box>
            <Divider />
            {accountActions}
          </Drawer>
          <BottomNavigation
            value={bottomValue < 0 ? false : bottomValue}
            onChange={(_event, value) => navigate(bottomItems[value].to)}
            showLabels
            sx={{
              position: 'fixed',
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: (muiTheme) => muiTheme.zIndex.appBar,
              '@media print': { display: 'none' },
            }}
          >
            {bottomItems.map((item) => (
              <BottomNavigationAction
                key={item.to}
                label={item.label}
                icon={item.icon}
                aria-label={item.label}
              />
            ))}
          </BottomNavigation>
        </>
      )}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          pb: { xs: 10, md: 0 },
        }}
      >
        <PendingOpsBanner />
        <Outlet key={tenantContext?.tenantId} />
      </Box>
    </Box>
  );
}
