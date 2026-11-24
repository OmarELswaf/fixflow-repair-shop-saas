DROP POLICY memberships_bootstrap_select ON memberships;
DROP POLICY refresh_sessions_bootstrap_select ON refresh_sessions;
CREATE POLICY memberships_auth_select ON memberships FOR SELECT
USING ("userId" = NULLIF(current_setting('app.auth_user_id',true),''));
CREATE POLICY refresh_auth_select ON refresh_sessions FOR SELECT USING (
  "tokenHash" = NULLIF(current_setting('app.refresh_hash',true),'') OR
  "id" = NULLIF(current_setting('app.refresh_id',true),'') OR
  "userId" = NULLIF(current_setting('app.auth_user_id',true),'')
);
