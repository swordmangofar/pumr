use crate::error::{AppError, Result};
use crate::models::{
    Attachment, DailySpend, FileChange, Mention, Message, ModelSpend, Project, Session,
    SessionSpend, SpendStats, SpendSummary, ToolCallRecord,
};
use chrono::{Local, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;
use std::sync::Mutex;
use uuid::Uuid;

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub struct NewMessage<'a> {
    pub role: &'a str,
    pub content: &'a str,
    pub reasoning: &'a str,
    pub model: Option<&'a str>,
    pub provider: Option<&'a str>,
    pub cost: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub tool_calls: &'a [ToolCallRecord],
    pub tool_call_id: Option<&'a str>,
    pub tool_name: Option<&'a str>,
    pub status: Option<&'a str>,
    pub changes: &'a [FileChange],
    pub base_commit: Option<&'a str>,
    pub attachments: &'a [Attachment],
    pub mentions: &'a [Mention],
    pub context: &'a str,
}

impl<'a> NewMessage<'a> {
    pub fn user(
        content: &'a str,
        context: &'a str,
        base_commit: Option<&'a str>,
        attachments: &'a [Attachment],
        mentions: &'a [Mention],
    ) -> Self {
        Self {
            role: "user",
            content,
            reasoning: "",
            model: None,
            provider: None,
            cost: 0.0,
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            tool_calls: &[],
            tool_call_id: None,
            tool_name: None,
            status: None,
            changes: &[],
            base_commit,
            attachments,
            mentions,
            context,
        }
    }

    pub fn assistant(model: Option<&'a str>, provider: Option<&'a str>) -> Self {
        Self {
            role: "assistant",
            content: "",
            reasoning: "",
            model,
            provider,
            cost: 0.0,
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            tool_calls: &[],
            tool_call_id: None,
            tool_name: None,
            status: None,
            changes: &[],
            base_commit: None,
            attachments: &[],
            mentions: &[],
            context: "",
        }
    }

    pub fn tool(
        call_id: &'a str,
        name: &'a str,
        content: &'a str,
        status: &'a str,
        changes: &'a [FileChange],
    ) -> Self {
        Self {
            role: "tool",
            content,
            reasoning: "",
            model: None,
            provider: None,
            cost: 0.0,
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            tool_calls: &[],
            tool_call_id: Some(call_id),
            tool_name: Some(name),
            status: Some(status),
            changes,
            base_commit: None,
            attachments: &[],
            mentions: &[],
            context: "",
        }
    }
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_opened_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                model TEXT,
                reasoning_effort TEXT,
                provider TEXT,
                system_prompt TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                cost REAL NOT NULL DEFAULT 0,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                reasoning TEXT NOT NULL DEFAULT '',
                model TEXT,
                provider TEXT,
                cost REAL NOT NULL DEFAULT 0,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
            CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);
            "#,
        )?;
        for (column, definition) in [
            ("tool_calls", "TEXT NOT NULL DEFAULT '[]'"),
            ("tool_call_id", "TEXT"),
            ("tool_name", "TEXT"),
            ("status", "TEXT"),
            ("changes", "TEXT NOT NULL DEFAULT '[]'"),
            ("base_commit", "TEXT"),
            ("attachments", "TEXT NOT NULL DEFAULT '[]'"),
            ("mentions", "TEXT NOT NULL DEFAULT '[]'"),
            ("context", "TEXT NOT NULL DEFAULT ''"),
        ] {
            add_column_if_missing(&conn, "messages", column, definition)?;
        }
        for (column, definition) in [
            ("parent_session_id", "TEXT"),
            ("agent_status", "TEXT"),
            ("archived", "INTEGER NOT NULL DEFAULT 0"),
            ("mode_id", "TEXT"),
        ] {
            add_column_if_missing(&conn, "sessions", column, definition)?;
        }
        // A run that was interrupted by an app restart can never resume.
        conn.execute(
            "UPDATE sessions SET agent_status = 'stopped' WHERE agent_status = 'running'",
            [],
        )?;
        Ok(())
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().unwrap();
        f(&conn)
    }

    pub fn upsert_project(&self, path: &str) -> Result<Project> {
        let now = now_ms();
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        self.with_conn(|conn| {
            if let Some(existing) = conn
                .query_row(
                    "SELECT id, path, name, created_at, last_opened_at FROM projects WHERE path = ?1",
                    params![path],
                    map_project_base,
                )
                .optional()?
            {
                conn.execute(
                    "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
                    params![now, existing.id],
                )?;
                return self.project_with_stats(conn, existing.id);
            }
            let id = new_id();
            conn.execute(
                "INSERT INTO projects (id, path, name, created_at, last_opened_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, path, name, now, now],
            )?;
            self.project_with_stats(conn, id)
        })
    }

    fn project_with_stats(&self, conn: &Connection, id: String) -> Result<Project> {
        conn.query_row(
            r#"
            SELECT p.id, p.path, p.name, p.created_at, p.last_opened_at,
                   (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.archived = 0),
                   COALESCE((SELECT SUM(s.cost) FROM sessions s WHERE s.project_id = p.id), 0)
            FROM projects p WHERE p.id = ?1
            "#,
            params![id],
            map_project,
        )
        .map_err(AppError::from)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT p.id, p.path, p.name, p.created_at, p.last_opened_at,
                       (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.archived = 0),
                       COALESCE((SELECT SUM(s.cost) FROM sessions s WHERE s.project_id = p.id), 0)
                FROM projects p
                ORDER BY p.last_opened_at DESC
                "#,
            )?;
            let rows = stmt.query_map([], map_project)?;
            let mut projects = Vec::new();
            for row in rows {
                projects.push(row?);
            }
            Ok(projects)
        })
    }

    pub fn get_project(&self, project_id: &str) -> Result<Project> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT id, path, name, created_at, last_opened_at, 0, 0 FROM projects WHERE id = ?1",
                params![project_id],
                map_project,
            )
            .map_err(AppError::from)
        })
    }

    pub fn remove_project(&self, project_id: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
            Ok(())
        })
    }

    pub fn touch_project(&self, project_id: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
                params![now_ms(), project_id],
            )?;
            Ok(())
        })
    }

    pub fn create_session(
        &self,
        project_id: &str,
        title: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        provider: Option<&str>,
        system_prompt: Option<&str>,
        mode_id: Option<&str>,
    ) -> Result<Session> {
        let id = new_id();
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                r#"INSERT INTO sessions
                   (id, project_id, title, model, reasoning_effort, provider, system_prompt,
                    mode_id, created_at, updated_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)"#,
                params![
                    id,
                    project_id,
                    title,
                    model,
                    reasoning_effort,
                    provider,
                    system_prompt,
                    mode_id,
                    now
                ],
            )?;
            self.session_by_id(conn, &id)
        })
    }

    pub fn list_sessions(&self, project_id: &str, include_archived: bool) -> Result<Vec<Session>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT s.id, s.project_id, s.title, s.model, s.reasoning_effort, s.provider,
                       s.system_prompt, s.created_at, s.updated_at, s.cost, s.prompt_tokens,
                       s.completion_tokens, s.cached_tokens,
                       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id),
                       s.parent_session_id, s.agent_status, s.archived, s.mode_id
                FROM sessions s
                WHERE s.project_id = ?1 AND s.parent_session_id IS NULL
                      AND (?2 = 1 OR s.archived = 0)
                ORDER BY s.updated_at DESC
                "#,
            )?;
            let rows = stmt.query_map(params![project_id, include_archived], map_session)?;
            let mut sessions = Vec::new();
            for row in rows {
                sessions.push(row?);
            }
            Ok(sessions)
        })
    }

    pub fn list_sub_sessions(&self, parent_session_id: &str) -> Result<Vec<Session>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT s.id, s.project_id, s.title, s.model, s.reasoning_effort, s.provider,
                       s.system_prompt, s.created_at, s.updated_at, s.cost, s.prompt_tokens,
                       s.completion_tokens, s.cached_tokens,
                       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id),
                       s.parent_session_id, s.agent_status, s.archived, s.mode_id
                FROM sessions s
                WHERE s.parent_session_id = ?1
                ORDER BY s.created_at ASC
                "#,
            )?;
            let rows = stmt.query_map(params![parent_session_id], map_session)?;
            let mut sessions = Vec::new();
            for row in rows {
                sessions.push(row?);
            }
            Ok(sessions)
        })
    }

    pub fn get_session(&self, id: &str) -> Result<Session> {
        self.with_conn(|conn| self.session_by_id(conn, id))
    }

    fn session_by_id(&self, conn: &Connection, id: &str) -> Result<Session> {
        conn.query_row(
            r#"
            SELECT s.id, s.project_id, s.title, s.model, s.reasoning_effort, s.provider,
                   s.system_prompt, s.created_at, s.updated_at, s.cost, s.prompt_tokens,
                   s.completion_tokens, s.cached_tokens,
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id),
                   s.parent_session_id, s.agent_status, s.archived, s.mode_id
            FROM sessions s WHERE s.id = ?1
            "#,
            params![id],
            map_session,
        )
        .map_err(AppError::from)
    }

    pub fn create_sub_session(
        &self,
        project_id: &str,
        parent_session_id: &str,
        title: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        provider: Option<&str>,
        system_prompt: Option<&str>,
    ) -> Result<Session> {
        let id = new_id();
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                r#"INSERT INTO sessions
                   (id, project_id, parent_session_id, title, model, reasoning_effort, provider,
                    system_prompt, created_at, updated_at, agent_status)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 'running')"#,
                params![
                    id,
                    project_id,
                    parent_session_id,
                    title,
                    model,
                    reasoning_effort,
                    provider,
                    system_prompt,
                    now
                ],
            )?;
            self.session_by_id(conn, &id)
        })
    }

    pub fn set_agent_status(&self, session_id: &str, status: &str) -> Result<Session> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE sessions SET agent_status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, now_ms(), session_id],
            )?;
            self.session_by_id(conn, session_id)
        })
    }

    pub fn update_session(
        &self,
        id: &str,
        title: Option<&str>,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        provider: Option<&str>,
        system_prompt: Option<&str>,
        mode_id: Option<&str>,
        project_id: Option<&str>,
    ) -> Result<Session> {
        self.with_conn(|conn| {
            let current = self.session_by_id(conn, id)?;
            let provider = match provider {
                Some(value) if value.trim().is_empty() => None,
                Some(value) => Some(value),
                None => current.provider.as_deref(),
            };
            let mode_id = match mode_id {
                Some(value) if value.trim().is_empty() => None,
                Some(value) => Some(value),
                None => current.mode_id.as_deref(),
            };
            let project_id = project_id.unwrap_or(&current.project_id);
            conn.execute(
                r#"UPDATE sessions SET
                     project_id = ?1, title = ?2, model = ?3, reasoning_effort = ?4, provider = ?5,
                     system_prompt = ?6, mode_id = ?7, updated_at = ?8
                   WHERE id = ?9"#,
                params![
                    project_id,
                    title.unwrap_or(&current.title),
                    model.or(current.model.as_deref()),
                    reasoning_effort.or(current.reasoning_effort.as_deref()),
                    provider,
                    system_prompt.or(current.system_prompt.as_deref()),
                    mode_id,
                    now_ms(),
                    id
                ],
            )?;
            self.session_by_id(conn, id)
        })
    }

    pub fn set_session_archived(&self, id: &str, archived: bool) -> Result<Session> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE sessions SET archived = ?1 WHERE id = ?2",
                params![archived, id],
            )?;
            self.session_by_id(conn, id)
        })
    }

    pub fn delete_session(&self, id: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    pub fn list_messages(&self, session_id: &str) -> Result<Vec<Message>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"SELECT id, session_id, seq, role, content, reasoning, model, provider,
                          cost, prompt_tokens, completion_tokens, cached_tokens, created_at,
                          tool_calls, tool_call_id, tool_name, status, changes, base_commit,
                          attachments, mentions, context
                   FROM messages WHERE session_id = ?1 ORDER BY seq ASC"#,
            )?;
            let rows = stmt.query_map(params![session_id], map_message)?;
            let mut messages = Vec::new();
            for row in rows {
                messages.push(row?);
            }
            Ok(messages)
        })
    }

    pub fn get_message(&self, id: &str) -> Result<Message> {
        self.with_conn(|conn| self.message_by_id(conn, id))
    }

    pub fn append_message(&self, session_id: &str, message: NewMessage<'_>) -> Result<Message> {
        let id = new_id();
        let now = now_ms();
        let tool_calls = serde_json::to_string(message.tool_calls)?;
        let changes = serde_json::to_string(message.changes)?;
        let attachments = serde_json::to_string(message.attachments)?;
        let mentions = serde_json::to_string(message.mentions)?;
        self.with_conn(|conn| {
            let seq: i64 = conn.query_row(
                "SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )?;
            conn.execute(
                r#"INSERT INTO messages
                   (id, session_id, seq, role, content, reasoning, model, provider, cost,
                    prompt_tokens, completion_tokens, cached_tokens, created_at,
                    tool_calls, tool_call_id, tool_name, status, changes, base_commit,
                    attachments, mentions, context)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                           ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)"#,
                params![
                    id,
                    session_id,
                    seq,
                    message.role,
                    message.content,
                    message.reasoning,
                    message.model,
                    message.provider,
                    message.cost,
                    message.prompt_tokens,
                    message.completion_tokens,
                    message.cached_tokens,
                    now,
                    tool_calls,
                    message.tool_call_id,
                    message.tool_name,
                    message.status,
                    changes,
                    message.base_commit,
                    attachments,
                    mentions,
                    message.context
                ],
            )?;
            conn.execute(
                "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
                params![now, session_id],
            )?;
            self.message_by_id(conn, &id)
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_assistant_message(
        &self,
        id: &str,
        content: &str,
        reasoning: &str,
        cost: f64,
        prompt_tokens: i64,
        completion_tokens: i64,
        cached_tokens: i64,
        tool_calls: &[ToolCallRecord],
        changes: &[FileChange],
    ) -> Result<Message> {
        let tool_calls = serde_json::to_string(tool_calls)?;
        let changes = serde_json::to_string(changes)?;
        self.with_conn(|conn| {
            conn.execute(
                r#"UPDATE messages SET content = ?1, reasoning = ?2, cost = ?3,
                     prompt_tokens = ?4, completion_tokens = ?5, cached_tokens = ?6,
                     tool_calls = ?7, changes = ?8
                   WHERE id = ?9"#,
                params![
                    content,
                    reasoning,
                    cost,
                    prompt_tokens,
                    completion_tokens,
                    cached_tokens,
                    tool_calls,
                    changes,
                    id
                ],
            )?;
            self.message_by_id(conn, id)
        })
    }

    pub fn delete_messages_from(&self, session_id: &str, seq: i64) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM messages WHERE session_id = ?1 AND seq >= ?2",
                params![session_id, seq],
            )?;
            Ok(())
        })
    }

    pub fn session_base_commit(&self, session_id: &str) -> Result<Option<String>> {
        self.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT base_commit FROM messages WHERE session_id = ?1 AND base_commit IS NOT NULL ORDER BY seq ASC LIMIT 1",
                    params![session_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })
    }

    fn message_by_id(&self, conn: &Connection, id: &str) -> Result<Message> {
        conn.query_row(
            r#"SELECT id, session_id, seq, role, content, reasoning, model, provider,
                      cost, prompt_tokens, completion_tokens, cached_tokens, created_at,
                      tool_calls, tool_call_id, tool_name, status, changes, base_commit,
                      attachments, mentions, context
               FROM messages WHERE id = ?1"#,
            params![id],
            map_message,
        )
        .map_err(AppError::from)
    }

    pub fn add_session_usage(
        &self,
        session_id: &str,
        cost: f64,
        prompt_tokens: i64,
        completion_tokens: i64,
        cached_tokens: i64,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                r#"UPDATE sessions SET
                     cost = cost + ?1,
                     prompt_tokens = prompt_tokens + ?2,
                     completion_tokens = completion_tokens + ?3,
                     cached_tokens = cached_tokens + ?4,
                     updated_at = ?5
                   WHERE id = ?6"#,
                params![
                    cost,
                    prompt_tokens,
                    completion_tokens,
                    cached_tokens,
                    now_ms(),
                    session_id
                ],
            )?;
            Ok(())
        })
    }

    pub fn spend(&self, session_id: Option<&str>, budget_usd: f64) -> Result<SpendSummary> {
        self.with_conn(|conn| {
            let (total_cost, prompt_tokens, completion_tokens, cached_tokens): (
                f64,
                i64,
                i64,
                i64,
            ) = conn.query_row(
                r#"SELECT COALESCE(SUM(cost), 0), COALESCE(SUM(prompt_tokens), 0),
                              COALESCE(SUM(completion_tokens), 0), COALESCE(SUM(cached_tokens), 0)
                       FROM sessions"#,
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            let session_cost = match session_id {
                Some(id) => conn
                    .query_row(
                        "SELECT COALESCE(cost, 0) FROM sessions WHERE id = ?1",
                        params![id],
                        |row| row.get::<_, f64>(0),
                    )
                    .optional()?
                    .unwrap_or(0.0),
                None => 0.0,
            };
            let today_start = Local
                .from_local_datetime(&Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap())
                .single()
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0);
            let today_cost: f64 = conn.query_row(
                "SELECT COALESCE(SUM(cost), 0) FROM messages WHERE created_at >= ?1",
                params![today_start],
                |row| row.get(0),
            )?;
            let remaining = if budget_usd > 0.0 {
                Some((budget_usd - total_cost).max(0.0))
            } else {
                None
            };
            Ok(SpendSummary {
                total_cost,
                today_cost,
                session_cost,
                budget_usd,
                remaining_usd: remaining,
                prompt_tokens,
                completion_tokens,
                cached_tokens,
            })
        })
    }

    pub fn spend_stats(&self, from_ms: i64, to_ms: i64, bucket: &str) -> Result<SpendStats> {
        self.with_conn(|conn| {
            let (total_cost, prompt_tokens, completion_tokens, cached_tokens, messages): (
                f64,
                i64,
                i64,
                i64,
                i64,
            ) = conn.query_row(
                r#"SELECT COALESCE(SUM(cost), 0), COALESCE(SUM(prompt_tokens), 0),
                          COALESCE(SUM(completion_tokens), 0), COALESCE(SUM(cached_tokens), 0),
                          COUNT(*)
                   FROM messages
                   WHERE created_at >= ?1 AND created_at <= ?2"#,
                params![from_ms, to_ms],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;

            let daily = {
                let pattern = match bucket {
                    "hour" => "%Y-%m-%d %H:00",
                    _ => "%Y-%m-%d",
                };
                let sql = format!(
                    r#"
                    SELECT strftime('{pattern}', created_at / 1000, 'unixepoch', 'localtime') AS bucket,
                           COALESCE(SUM(cost), 0), COALESCE(SUM(prompt_tokens), 0),
                           COALESCE(SUM(completion_tokens), 0), COALESCE(SUM(cached_tokens), 0)
                    FROM messages
                    WHERE created_at >= ?1 AND created_at <= ?2
                    GROUP BY bucket
                    ORDER BY bucket ASC
                    "#
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![from_ms, to_ms], |row| {
                    Ok(DailySpend {
                        date: row.get(0)?,
                        cost: row.get(1)?,
                        prompt_tokens: row.get(2)?,
                        completion_tokens: row.get(3)?,
                        cached_tokens: row.get(4)?,
                    })
                })?;
                let mut items = Vec::new();
                for row in rows {
                    items.push(row?);
                }
                items
            };

            let by_model = {
                let mut stmt = conn.prepare(
                    r#"
                    SELECT model, provider, COALESCE(SUM(cost), 0),
                           COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0),
                           COALESCE(SUM(cached_tokens), 0), COUNT(*)
                    FROM messages
                    WHERE created_at >= ?1 AND created_at <= ?2 AND model IS NOT NULL
                    GROUP BY model, provider
                    ORDER BY SUM(cost) DESC
                    "#,
                )?;
                let rows = stmt.query_map(params![from_ms, to_ms], |row| {
                    Ok(ModelSpend {
                        model: row.get(0)?,
                        provider: row.get(1)?,
                        cost: row.get(2)?,
                        prompt_tokens: row.get(3)?,
                        completion_tokens: row.get(4)?,
                        cached_tokens: row.get(5)?,
                        messages: row.get(6)?,
                    })
                })?;
                let mut items = Vec::new();
                for row in rows {
                    items.push(row?);
                }
                items
            };

            let by_session = {
                let mut stmt = conn.prepare(
                    r#"
                    SELECT m.session_id, s.title, s.project_id, s.parent_session_id,
                           COALESCE(SUM(m.cost), 0), COALESCE(SUM(m.prompt_tokens), 0),
                           COALESCE(SUM(m.completion_tokens), 0), COALESCE(SUM(m.cached_tokens), 0),
                           COUNT(*), s.updated_at
                    FROM messages m
                    JOIN sessions s ON s.id = m.session_id
                    WHERE m.created_at >= ?1 AND m.created_at <= ?2
                    GROUP BY m.session_id
                    ORDER BY SUM(m.cost) DESC
                    "#,
                )?;
                let rows = stmt.query_map(params![from_ms, to_ms], |row| {
                    Ok(SessionSpend {
                        session_id: row.get(0)?,
                        title: row.get(1)?,
                        project_id: row.get(2)?,
                        parent_session_id: row.get(3)?,
                        cost: row.get(4)?,
                        prompt_tokens: row.get(5)?,
                        completion_tokens: row.get(6)?,
                        cached_tokens: row.get(7)?,
                        messages: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                })?;
                let mut items = Vec::new();
                for row in rows {
                    items.push(row?);
                }
                items
            };

            let sessions = by_session
                .iter()
                .filter(|s| s.parent_session_id.is_none())
                .count() as i64;

            Ok(SpendStats {
                total_cost,
                prompt_tokens,
                completion_tokens,
                cached_tokens,
                messages,
                sessions,
                daily,
                by_model,
                by_session,
            })
        })
    }
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(std::result::Result::ok)
        .any(|name| name == column);
    drop(stmt);
    if !exists {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

fn map_project_base(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
        last_opened_at: row.get(4)?,
        session_count: 0,
        total_cost: 0.0,
    })
}

fn map_project(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
        last_opened_at: row.get(4)?,
        session_count: row.get(5)?,
        total_cost: row.get(6)?,
    })
}

fn map_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        model: row.get(3)?,
        reasoning_effort: row.get(4)?,
        provider: row.get(5)?,
        system_prompt: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        cost: row.get(9)?,
        prompt_tokens: row.get(10)?,
        completion_tokens: row.get(11)?,
        cached_tokens: row.get(12)?,
        message_count: row.get(13)?,
        parent_session_id: row.get(14)?,
        agent_status: row.get(15)?,
        archived: row.get::<_, i64>(16)? != 0,
        mode_id: row.get(17)?,
    })
}

fn map_message(row: &Row<'_>) -> rusqlite::Result<Message> {
    let tool_calls: String = row.get(13)?;
    let changes: String = row.get(17)?;
    let attachments: String = row.get(19)?;
    let mentions: String = row.get(20)?;
    Ok(Message {
        id: row.get(0)?,
        session_id: row.get(1)?,
        seq: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        reasoning: row.get(5)?,
        model: row.get(6)?,
        provider: row.get(7)?,
        cost: row.get(8)?,
        prompt_tokens: row.get(9)?,
        completion_tokens: row.get(10)?,
        cached_tokens: row.get(11)?,
        created_at: row.get(12)?,
        tool_calls: serde_json::from_str(&tool_calls).unwrap_or_default(),
        tool_call_id: row.get(14)?,
        tool_name: row.get(15)?,
        status: row.get(16)?,
        changes: serde_json::from_str(&changes).unwrap_or_default(),
        base_commit: row.get(18)?,
        attachments: serde_json::from_str(&attachments).unwrap_or_default(),
        mentions: serde_json::from_str(&mentions).unwrap_or_default(),
        context: row.get(21)?,
    })
}
