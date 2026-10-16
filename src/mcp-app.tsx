import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardData } from "./shared";
import "./styles.css";

type Tab = "overview" | "metadata" | "data" | "jobs";
type JsonObject = Record<string, unknown>;

function structured<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function resultText(result: CallToolResult): string {
  const item = result.content?.find((content) => content.type === "text");
  return item?.type === "text" ? item.text : result.isError ? "Oracle EPM request failed." : "Request completed.";
}

function compact(values: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "" && value !== undefined));
}

function ResultViewer({ label, value }: { label: string; value: unknown }) {
  const summary = value && typeof value === "object" && "items" in value
    ? `${Array.isArray((value as JsonObject).items) ? ((value as JsonObject).items as unknown[]).length : 0} items`
    : "JSON response";
  return <section className="result-panel">
    <div className="result-head"><div><span>LAST RESPONSE</span><strong>{label || "Waiting for a request"}</strong></div><small>{value === undefined ? "No data" : summary}</small></div>
    {value === undefined
      ? <div className="empty compact-empty">Run an operation to inspect its structured Oracle response here.</div>
      : <pre>{JSON.stringify(value, null, 2)}</pre>}
  </section>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function AppView() {
  const [dashboard, setDashboard] = useState<DashboardData>();
  const [context, setContext] = useState<McpUiHostContext>();
  const [tab, setTab] = useState<Tab>("overview");
  const [busyTool, setBusyTool] = useState("");
  const [notice, setNotice] = useState("");
  const [lastLabel, setLastLabel] = useState("");
  const [lastData, setLastData] = useState<unknown>();

  const [application, setApplication] = useState("");
  const [planType, setPlanType] = useState("");
  const [dimension, setDimension] = useState("");
  const [member, setMember] = useState("");
  const [aliasTable, setAliasTable] = useState("Default");
  const [subVariable, setSubVariable] = useState("");
  const [gridJson, setGridJson] = useState(`{
  "pov": { "dimensions": [], "members": [] },
  "columns": [],
  "rows": []
}`);
  const [exportPlanningData, setExportPlanningData] = useState(false);
  const [jobType, setJobType] = useState("RULES");
  const [jobId, setJobId] = useState("");

  const handleIncomingResult = useCallback((result: CallToolResult, label = "Host tool result") => {
    const value = structured<JsonObject>(result);
    if (value?.connection) setDashboard(value as unknown as DashboardData);
    if (value && "data" in value) setLastData(value.data);
    else if (value && !value.connection) setLastData(value);
    setLastLabel(label);
    setNotice(resultText(result));
  }, []);

  const { app, error } = useApp({
    appInfo: { name: "Oracle EPM Command Center", version: "0.2.0" },
    capabilities: {},
    onAppCreated: (instance) => {
      instance.ontoolinput = () => {};
      instance.ontoolresult = (result) => handleIncomingResult(result);
      instance.onhostcontextchanged = (next) => setContext((previous) => ({ ...previous, ...next }));
      instance.ontoolcancelled = () => setBusyTool("");
      instance.onteardown = async () => ({});
      instance.onerror = console.error;
    },
  });

  useEffect(() => {
    if (app) setContext(app.getHostContext());
  }, [app]);

  useEffect(() => {
    if (dashboard?.connection.application && !application) setApplication(dashboard.connection.application);
  }, [dashboard, application]);

  const insetStyle = useMemo(() => ({
    paddingTop: context?.safeAreaInsets?.top,
    paddingRight: context?.safeAreaInsets?.right,
    paddingBottom: context?.safeAreaInsets?.bottom,
    paddingLeft: context?.safeAreaInsets?.left,
  }), [context]);

  const call = useCallback(async (name: string, args: JsonObject, label: string) => {
    if (!app) return undefined;
    setBusyTool(name);
    setNotice("");
    try {
      const result = await app.callServerTool({ name, arguments: compact(args) });
      handleIncomingResult(result, label);
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setNotice(message);
      return undefined;
    } finally {
      setBusyTool("");
    }
  }, [app, handleIncomingResult]);

  const refresh = useCallback(async () => {
    const result = await call("refresh-epm-dashboard", {}, "Dashboard refresh");
    const next = result && structured<DashboardData>(result);
    if (next?.connection) setDashboard(next);
  }, [call]);

  const exportSlice = useCallback(async () => {
    try {
      const parsed = JSON.parse(gridJson) as JsonObject;
      await call("export-epm-data-slice", { application, planType, gridDefinition: parsed, exportPlanningData }, "Exported data slice");
    } catch (cause) {
      if (cause instanceof SyntaxError) setNotice(`Invalid grid definition JSON: ${cause.message}`);
    }
  }, [application, call, exportPlanningData, gridJson, planType]);

  if (error) return <main className="shell"><div className="error">Could not connect: {error.message}</div></main>;
  if (!app) return <main className="shell"><div className="loading">Connecting to Oracle EPM...</div></main>;

  const configured = dashboard?.connection.configured;

  return <main className="shell" style={insetStyle}>
    <header>
      <div><div className="eyebrow">ORACLE EPM / NSPB</div><h1>Planning Command Center</h1><p>Discover, inspect, and query your planning environment with read-only tools.</p></div>
      <button className="secondary" onClick={refresh} disabled={Boolean(busyTool)}>{busyTool ? "Working..." : "Refresh status"}</button>
    </header>

    <section className="hero">
      <div><span className={`dot ${configured === false ? "offline" : "online"}`} /><span>{configured === undefined ? "Workspace ready" : configured ? "Configuration complete" : "Setup required"}</span></div>
      <strong>{(dashboard?.connection.application ?? application) || "No application configured"}</strong>
      <small>{dashboard?.connection.baseUrl ?? (dashboard ? `Missing: ${dashboard.connection.missing.join(", ") || "server configuration"}` : "Refresh status to inspect the configured Oracle environment")}</small>
    </section>

    <nav className="tabs" aria-label="Oracle EPM workspace">
      {(["overview", "metadata", "data", "jobs"] as Tab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item === "metadata" ? "Metadata" : item[0].toUpperCase() + item.slice(1)}</button>)}
    </nav>

    <div className="workspace">
      <div className="workspace-main">
        {tab === "overview" && <>
          <div className="section-heading"><div><span>ENVIRONMENT</span><h2>Start with context</h2></div><p>Discover accessible applications and load Oracle's agent-focused summary before operating.</p></div>
          <div className="action-grid three">
            <button className="action-card" onClick={() => call("get-epm-api-versions", {}, "Planning API versions")} disabled={Boolean(busyTool)}><b>API versions</b><span>Check connectivity and supported Planning versions.</span></button>
            <button className="action-card" onClick={() => call("list-epm-applications", {}, "Accessible applications")} disabled={Boolean(busyTool)}><b>Applications</b><span>Find applications available to the service account.</span></button>
            <button className="action-card accent" onClick={() => call("get-epm-application-summary", { application, aliasTableName: aliasTable === "Default" ? undefined : aliasTable }, "Application summary")} disabled={Boolean(busyTool)}><b>Application summary</b><span>Load Oracle's AI-focused structural overview.</span></button>
          </div>
        </>}

        {tab === "metadata" && <>
          <div className="section-heading"><div><span>STRUCTURE</span><h2>Explore metadata</h2></div><p>Move from cubes to dimensions, hierarchies, members, and substitution variables.</p></div>
          <section className="panel form-panel">
            <div className="form-grid">
              <Field label="Application" hint="Leave blank to use the server default."><input value={application} onChange={(event) => setApplication(event.target.value)} placeholder="NSPB" /></Field>
              <Field label="Alias table"><input value={aliasTable} onChange={(event) => setAliasTable(event.target.value)} placeholder="Default" /></Field>
              <Field label="Plan type / cube"><input value={planType} onChange={(event) => setPlanType(event.target.value)} placeholder="Plan1" /></Field>
              <Field label="Dimension"><input value={dimension} onChange={(event) => setDimension(event.target.value)} placeholder="Entity" /></Field>
              <Field label="Member"><input value={member} onChange={(event) => setMember(event.target.value)} placeholder="North America" /></Field>
              <Field label="Substitution variable"><input value={subVariable} onChange={(event) => setSubVariable(event.target.value)} placeholder="CurrYear" /></Field>
            </div>
            <div className="button-row">
              <button className="secondary" onClick={() => call("list-epm-plan-types", { application }, "Plan types")} disabled={Boolean(busyTool)}>List plan types</button>
              <button className="secondary" onClick={() => call("list-epm-dimensions", { application, planType, limit: 100 }, `Dimensions in ${planType}`)} disabled={Boolean(busyTool) || !planType}>List dimensions</button>
              <button className="secondary" onClick={() => call("get-epm-dimension", { application, planType, dimension, aliasTableName: aliasTable, fields: "id,name,alias,path,children" }, `${dimension} hierarchy`)} disabled={Boolean(busyTool) || !planType || !dimension}>Get hierarchy</button>
              <button className="secondary" onClick={() => call("get-epm-member", { application, dimension, member }, `${member} properties`)} disabled={Boolean(busyTool) || !dimension || !member}>Get member</button>
              <button className="secondary" onClick={() => call("list-epm-substitution-variables", { application }, "Substitution variables")} disabled={Boolean(busyTool)}>List variables</button>
              <button className="secondary" onClick={() => call("get-epm-substitution-variable", { application, name: subVariable }, `${subVariable} value`)} disabled={Boolean(busyTool) || !subVariable}>Get variable</button>
            </div>
          </section>
        </>}

        {tab === "data" && <>
          <div className="section-heading"><div><span>DATA QUERY</span><h2>Export a data slice</h2></div><p>Define a narrow POV, columns, and rows grid. This endpoint reads data and does not write it.</p></div>
          <section className="panel form-panel">
            <div className="form-grid two">
              <Field label="Application"><input value={application} onChange={(event) => setApplication(event.target.value)} placeholder="Server default" /></Field>
              <Field label="Plan type / cube"><input value={planType} onChange={(event) => setPlanType(event.target.value)} placeholder="Plan1" /></Field>
            </div>
            <Field label="Oracle gridDefinition JSON" hint="Include dimension names for more efficient Oracle processing."><textarea className="code-area tall" value={gridJson} onChange={(event) => setGridJson(event.target.value)} spellCheck={false} /></Field>
            <label className="check-row"><input type="checkbox" checked={exportPlanningData} onChange={(event) => setExportPlanningData(event.target.checked)} /><span>Include Planning cell notes and supporting detail</span></label>
            <button className="primary" onClick={exportSlice} disabled={Boolean(busyTool) || !planType}>Export data slice</button>
          </section>
        </>}

        {tab === "jobs" && <>
          <div className="section-heading"><div><span>READ-ONLY JOBS</span><h2>Inspect jobs</h2></div><p>Discover configured job definitions and inspect the status or processing details of an existing job ID. Execution is intentionally disabled.</p></div>
          <div className="job-ops">
            <section className="panel form-panel">
              <div className="panel-title"><div><span>DISCOVER</span><h2>Job definitions</h2></div></div>
              <Field label="Optional job type filter" hint="Leave blank to list all definitions visible to the service account."><input value={jobType} onChange={(event) => setJobType(event.target.value)} placeholder="RULES" /></Field>
              <button className="secondary" onClick={() => call("list-epm-job-definitions", { application, jobType }, `${jobType || "All"} job definitions`)} disabled={Boolean(busyTool)}>Find definitions</button>
            </section>
            <section className="panel form-panel">
              <div className="panel-title"><div><span>MONITOR</span><h2>Check job status</h2></div></div>
              <Field label="Oracle job ID"><input value={jobId} onChange={(event) => setJobId(event.target.value)} placeholder="224" /></Field>
              <div className="button-row stacked">
                <button className="secondary" onClick={() => call("get-epm-job-status", { application, jobId }, `Status for job ${jobId}`)} disabled={Boolean(busyTool) || !jobId}>Get status</button>
                <button className="secondary" onClick={() => call("get-epm-job-details", { application, jobId, messageType: "ERROR", limit: 100 }, `Errors for job ${jobId}`)} disabled={Boolean(busyTool) || !jobId}>Get error details</button>
              </div>
              <p className="hint">Provide an existing Oracle job ID created outside this MCP server. These controls do not submit, rerun, or cancel work.</p>
            </section>
          </div>
        </>}
      </div>
      <aside><ResultViewer label={lastLabel} value={lastData} /></aside>
    </div>

    {notice && <div className="toast"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss">x</button></div>}
    <footer>Last environment check {dashboard?.checkedAt ? new Date(dashboard.checkedAt).toLocaleString() : "when opened"}</footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><AppView /></StrictMode>);
