import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  Activity, ArrowUpRight, BadgeCheck, Boxes,
  CircleHelp, CircleX, ClipboardList, CloudSun, Factory, Flower2, Hexagon, House as HiveIcon,
  LoaderCircle, LogOut, MapPin, Plus, QrCode, RefreshCw, ScanLine,
  Package, ShieldCheck, Thermometer, Truck, Weight, Wind, X,
} from "lucide-react";
import { api, setAccessToken, type Batch, type BatchStage, type BatchStageType, type Hive, type HiveAnalysis, type SensorReading, type User } from "./api";

type DashboardData = { counts: { hives: number; batches: number }; readings: SensorReading[]; batches: Batch[] };
type PublicBatch = Omit<Batch, "hive" | "beekeeper"> & {
  hive: { name: string };
  beekeeper: { name: string };
  chainVerified: boolean | null;
  verification: string;
  stages: BatchStage[];
  chainProof: null | {
    dataDigest: string;
    recordedBy: string;
    recordedAt: string;
    network: string;
    transactionHash: string | null;
    contractAddress: string | null;
  };
};
type ModalState = "hive" | "batch" | "history" | "qr" | "review" | "stage" | null;

function formatDate(value?: string, dateOnly = false) {
  if (!value) return "No readings yet";
  const harvestDay = dateOnly || value.length === 10 || value.endsWith("T00:00:00.000Z");
  const options: Intl.DateTimeFormatOptions = harvestDay
    ? { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-IN", options).format(new Date(value));
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(Boolean(localStorage.getItem("honeychain-token")));

  useEffect(() => {
    if (!localStorage.getItem("honeychain-token")) return;
    api<User>("/auth/me").then(setUser).catch(() => setAccessToken(null)).finally(() => setCheckingSession(false));
  }, []);

  const signOut = () => {
    setAccessToken(null);
    setUser(null);
  };

  return (
    <Routes>
      <Route path="/verify/:code" element={<PublicVerification />} />
      <Route path="*" element={checkingSession ? <ScreenLoader /> : user ? <Workspace user={user} onSignOut={signOut} /> : <AuthScreen onAuthenticated={setUser} />} />
    </Routes>
  );
}

function ScreenLoader() {
  return <div className="screen-loader"><LoaderCircle className="spin" size={24} /><span>Opening your apiary</span></div>;
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try {
      const result = await api<{ token: string; user: User }>(`/auth/${mode}`, { method: "POST", body: JSON.stringify(payload) });
      setAccessToken(result.token);
      onAuthenticated(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-story">
        <div className="brand-mark"><Hexagon size={22} strokeWidth={2.5} /><span>HONEYCHAIN</span></div>
        <div className="story-copy">
          <p className="eyebrow">APIARY INTELLIGENCE · BATCH PROVENANCE</p>
          <h1>Better records.<br /><em>Stronger colonies.</em></h1>
          <p className="story-intro">One clear view of the hive, from first reading to verified harvest.</p>
        </div>
        <div className="auth-landscape" aria-hidden="true">
          <div className="landscape-sun" /><div className="landscape-hill hill-back" /><div className="landscape-hill hill-front" />
          <div className="landscape-hive"><span /><span /><span /></div>
          <div className="landscape-caption"><span className="live-dot" /> FIELD JOURNAL · 01</div>
        </div>
        <div className="auth-footer"><span>SIH26021</span><span>TRACEABILITY / HEALTH / CARE</span></div>
      </section>
      <section className="auth-panel">
        <div className="auth-panel-top"><span>FIELD CONSOLE</span><span className="online-label"><i /> SYSTEM READY</span></div>
        <div className="auth-form-wrap">
          <p className="eyebrow">{mode === "register" ? "NEW BEEKEEPER ACCOUNT" : "WELCOME BACK"}</p>
          <h2>{mode === "register" ? "Start your apiary log" : "Return to your apiary"}</h2>
          <p className="muted">{mode === "register" ? "Create an account to register hives and record harvests." : "Sign in to continue managing your hives."}</p>
          <form onSubmit={submit} className="form-stack">
            {mode === "register" && <label>Full name<input name="name" autoComplete="name" placeholder="Your name" minLength={2} required /></label>}
            <label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label>
            <label>Password<input name="password" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} placeholder={mode === "register" ? "At least 10 characters" : "Your password"} minLength={mode === "register" ? 10 : 1} required /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button button-primary auth-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : null}{mode === "register" ? "Create beekeeper account" : "Sign in"}<ArrowUpRight size={17} /></button>
          </form>
          <p className="auth-switch">{mode === "register" ? "Already have an account?" : "New to HoneyChain?"} <button onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); }}>{mode === "register" ? "Sign in" : "Create an account"}</button></p>
        </div>
        <p className="auth-legal"><ShieldCheck size={14} /> Your apiary records are private to your account.</p>
      </section>
    </main>
  );
}

function Workspace({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [section, setSection] = useState("Overview");
  const [summary, setSummary] = useState<DashboardData | null>(null);
  const [hives, setHives] = useState<Hive[]>([]);
  const [hiveInsights, setHiveInsights] = useState<Record<string, HiveAnalysis>>({});
  const [batches, setBatches] = useState<Batch[]>([]);
  const [reviewQueue, setReviewQueue] = useState<Batch[]>([]);
  const [blockchain, setBlockchain] = useState<{ configured: boolean; network: string | null }>({ configured: false, network: null });
  const [modal, setModal] = useState<ModalState>(null);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [selectedStage, setSelectedStage] = useState<Exclude<BatchStageType, "HARVESTED" | "VERIFIED" | "CONSUMER_VERIFIED">>("PROCESSED");
  const [flash, setFlash] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setError("");
    try {
      const [dashboardData, hiveData, batchData, chainData, queueData] = await Promise.all([
        api<DashboardData>("/dashboard"), api<Hive[]>("/hives"), api<Batch[]>("/batches"), api<typeof blockchain>("/blockchain/status"),
        user.role === "VERIFIER" || user.role === "ADMIN" ? api<Batch[]>("/verifier/batches") : Promise.resolve([]),
      ]);
      const insightMap = hiveData.length ? Object.fromEntries(await Promise.all(hiveData.map(async (hive) => [hive.id, await api<HiveAnalysis>(`/hives/${hive.id}/analysis`)]))) : {};
      setSummary(dashboardData);
      setHives(hiveData);
      setHiveInsights(insightMap);
      setBatches(batchData);
      setBlockchain(chainData);
      setReviewQueue(queueData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load apiary data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(""), 3600);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const createSensorReading = async (hive: Hive) => {
    try {
      await api(`/hives/${hive.id}/readings/simulate`, { method: "POST" });
      setFlash(`Sampled ${hive.name} sensor data`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add sensor reading");
    }
  };

  const openBatch = (batch: Batch, modalType: "history" | "qr") => {
    setSelectedBatch(batch);
    setModal(modalType);
  };

  const advanceBatch = async (batch: Batch, status: "PROCESSING" | "SUBMITTED_FOR_VERIFICATION") => {
    try {
      await api(`/batches/${encodeURIComponent(batch.code)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      setFlash(status === "PROCESSING" ? `${batch.code} moved to processing` : `${batch.code} submitted for review`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the batch");
    }
  };

  const openStageForm = (batch: Batch, type: Exclude<BatchStageType, "HARVESTED" | "VERIFIED" | "CONSUMER_VERIFIED">) => {
    setSelectedBatch(batch);
    setSelectedStage(type);
    setModal("stage");
  };

  return (
    <div className="workspace">
      <aside className="sidebar">
        <Link className="brand-mark sidebar-brand" to="/"><Hexagon size={21} strokeWidth={2.5} /><span>HONEYCHAIN</span></Link>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <NavButton label="Overview" active={section === "Overview"} onClick={setSection} icon={<Activity size={17} />} />
          <NavButton label="Hives" active={section === "Hives"} onClick={setSection} icon={<HiveIcon size={17} />} count={hives.length} />
          <NavButton label="Honey batches" active={section === "Honey batches"} onClick={setSection} icon={<Boxes size={17} />} count={batches.length} />
          {(user.role === "VERIFIER" || user.role === "ADMIN") && <NavButton label="Verifier queue" active={section === "Verifier queue"} onClick={setSection} icon={<BadgeCheck size={17} />} count={reviewQueue.length} />}
        </nav>
        <div className="sidebar-spacer" />
        <div className={`chain-card ${blockchain.configured ? "chain-live" : ""}`}>
          <span className="chain-icon"><ShieldCheck size={16} /></span>
          <div><strong>{blockchain.configured ? "Chain connected" : "Chain not connected"}</strong><span>{blockchain.configured ? `Network ${blockchain.network}` : "Batch records stay local"}</span></div>
          <i className="status-dot" />
        </div>
        <div className="account-row">
          <div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div>
          <div className="account-copy"><strong>{user.name}</strong><span>{user.role === "VERIFIER" ? "Verifier / Lab" : user.role === "ADMIN" ? "Administrator" : user.role === "CONSUMER" ? "Consumer" : "Beekeeper"}</span></div>
          <button className="icon-button signout" title="Sign out" onClick={onSignOut}><LogOut size={16} /></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Apiary</span><span>/</span><strong>{section}</strong></div>
          <div className="topbar-right"><span className="date-stamp">{new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "long" }).format(new Date())}</span><button className="icon-button" title="Refresh data" onClick={() => void refresh()}><RefreshCw size={16} /></button><div className="top-avatar">{user.name.slice(0, 1).toUpperCase()}</div></div>
        </header>
        <div className="content-area">
          {error && <div className="notice notice-error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss"><X size={16} /></button></div>}
          {loading ? <ScreenLoader /> : section === "Hives" ? (
            <HivesView hives={hives} onAdd={() => setModal("hive")} onSimulate={createSensorReading} />
          ) : section === "Honey batches" ? (
            <BatchesView batches={batches} hives={hives} onAdd={() => setModal("batch")} onHistory={(batch) => openBatch(batch, "history")} onQr={(batch) => openBatch(batch, "qr")} onAdvance={advanceBatch} onRecordStage={openStageForm} />
          ) : section === "Verifier queue" && (user.role === "VERIFIER" || user.role === "ADMIN") ? (
            <VerifierQueue batches={reviewQueue} onReview={(batch) => { setSelectedBatch(batch); setModal("review"); }} />
          ) : (
            <OverviewView user={user} summary={summary} hives={hives} batches={batches} hiveInsights={hiveInsights} blockchain={blockchain} onAddHive={() => setModal("hive")} onAddBatch={() => setModal("batch")} onSection={setSection} onHistory={(batch) => openBatch(batch, "history")} onQr={(batch) => openBatch(batch, "qr")} onSimulate={createSensorReading} />
          )}
        </div>
      </main>

      {flash && <div className="toast"><BadgeCheck size={17} />{flash}</div>}
      {modal && <Modal onClose={() => setModal(null)}>
        {modal === "hive" && <HiveForm onCancel={() => setModal(null)} onCreated={async () => { setModal(null); setFlash("Hive registered"); await refresh(); }} />}
        {modal === "batch" && <BatchForm hives={hives} onCancel={() => setModal(null)} onCreated={async () => { setModal(null); setFlash("Harvest added to traceability"); await refresh(); }} />}
        {modal === "history" && selectedBatch && <BatchHistory batch={selectedBatch} onQr={() => setModal("qr")} />}
        {modal === "qr" && selectedBatch && <BatchQr batch={selectedBatch} />}
        {modal === "review" && selectedBatch && <ReviewForm batch={selectedBatch} onCancel={() => setModal(null)} onReviewed={async () => { setModal(null); setFlash(`${selectedBatch.code} review recorded`); await refresh(); }} />}
        {modal === "stage" && selectedBatch && <StageForm batch={selectedBatch} type={selectedStage} onCancel={() => setModal(null)} onSaved={async () => { setModal(null); setFlash(`${selectedStage.toLowerCase()} stage recorded`); await refresh(); }} />}
      </Modal>}
    </div>
  );
}

function NavButton({ label, icon, active, count, onClick }: { label: string; icon: ReactNode; active: boolean; count?: number; onClick: (label: string) => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={() => onClick(label)}>{icon}<span>{label}</span>{count !== undefined && count > 0 && <small>{count}</small>}</button>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div>{action}</div>;
}

function OverviewView({ user, summary, hives, batches, hiveInsights, blockchain, onAddHive, onAddBatch, onSection, onHistory, onQr, onSimulate }: {
  user: User; summary: DashboardData | null; hives: Hive[]; batches: Batch[]; hiveInsights: Record<string, HiveAnalysis>;
  blockchain: { configured: boolean; network: string | null };
  onAddHive: () => void; onAddBatch: () => void; onSection: (section: string) => void;
  onHistory: (batch: Batch) => void; onQr: (batch: Batch) => void; onSimulate: (hive: Hive) => void;
}) {
  const latestReading = summary?.readings[0];
  const featuredHive = hives[0];
  const featuredInsight = featuredHive ? hiveInsights[featuredHive.id] : undefined;
  return <>
    <PageHeading eyebrow="FIELD OVERVIEW · APIARY 01" title={`Good day, ${user.name.split(" ")[0]}.`} description="Your colonies, sensor activity and harvest records in one place." action={<button className="button button-primary" onClick={onAddBatch}><Plus size={17} /> Record harvest</button>} />
    <section className="metric-grid" aria-label="Apiary summary">
      <MetricCard label="REGISTERED HIVES" value={summary?.counts.hives ?? 0} note="Across your apiary" icon={<HiveIcon size={17} />} tone="green" />
      <MetricCard label="HONEY BATCHES" value={summary?.counts.batches ?? 0} note="Harvest records" icon={<Boxes size={17} />} tone="gold" />
      <MetricCard label="LAST TEMPERATURE" value={latestReading ? `${latestReading.temperatureC}°` : "—"} note={latestReading ? `${latestReading.hive?.name ?? "Hive"} · ${formatDate(latestReading.recordedAt)}` : "No sensor data received"} icon={<Thermometer size={17} />} tone="blue" />
      <MetricCard label="TRACEABILITY" value={blockchain.configured ? "On-chain" : "Ready"} note={blockchain.configured ? `Network ${blockchain.network}` : "Local batch history active"} icon={<ShieldCheck size={17} />} tone="rose" />
    </section>

    <div className="overview-grid">
      <section className="panel colony-panel">
        <div className="panel-heading"><div><span className="section-kicker">COLONY STATUS</span><h2>Your hives</h2></div><button className="text-button" onClick={() => onSection("Hives")}>All hives <ArrowUpRight size={15} /></button></div>
        {hives.length === 0 ? <EmptyState icon={<HiveIcon size={22} />} title="No hives registered" detail="Add your first hive to start recording colony conditions." action={<button className="button button-light" onClick={onAddHive}><Plus size={16} /> Register hive</button>} /> : (
          <div className="hive-list">{hives.slice(0, 4).map((hive) => <HiveRow key={hive.id} hive={hive} onSimulate={() => onSimulate(hive)} />)}</div>
        )}
        {hives.length > 0 && <button className="subtle-add" onClick={onAddHive}><Plus size={15} /> Add a hive</button>}
      </section>

      <section className="panel readings-panel">
        <div className="panel-heading"><div><span className="section-kicker">SENSOR FEED</span><h2>Recent readings</h2></div><span className="feed-state"><i /> LIVE LOG</span></div>
        {!summary?.readings.length ? <EmptyState icon={<CloudSun size={22} />} title="Waiting for hive data" detail="Generate a sample reading from a hive to see activity here." /> : (
          <div className="reading-list">{summary.readings.slice(0, 5).map((reading) => <ReadingRow key={reading.id} reading={reading} />)}</div>
        )}
        <p className="panel-footnote"><span className="simulated-mark" /> Simulator and manual readings are labelled by source.</p>
      </section>
    </div>

    <section className="panel batches-panel">
      <div className="panel-heading"><div><span className="section-kicker">PROVENANCE LEDGER</span><h2>Recent honey batches</h2></div><button className="text-button" onClick={() => onSection("Honey batches")}>View all <ArrowUpRight size={15} /></button></div>
      {batches.length === 0 ? <EmptyState icon={<Boxes size={22} />} title="No harvests recorded" detail="A batch starts with a hive harvest and grows a traceable event history." action={hives.length ? <button className="button button-light" onClick={onAddBatch}><Plus size={16} /> Record first harvest</button> : undefined} /> : <BatchTable batches={batches.slice(0, 5)} onHistory={onHistory} onQr={onQr} />}
    </section>
    <div className="overview-bottom"><div className="care-note"><Flower2 size={19} /><p><strong>Keep the field notes flowing.</strong><span>Regular readings make seasonal patterns easier to spot.</span></p><button onClick={() => hives[0] && onSimulate(hives[0])} disabled={!hives.length} className="text-button">Sample data <ArrowUpRight size={15} /></button></div><div className="ai-note"><span className="ai-spark">✳</span><p><strong>Colony insights</strong><span>{featuredInsight ? featuredInsight.explanation : "Add sensor data to generate the first health check."}</span>{featuredInsight && <span className="insight-metrics">Disease risk: {featuredInsight.diseaseRisk === null ? "Unscored" : `${featuredInsight.diseaseRisk}/100`} · Productivity: {featuredInsight.productivityTrend}</span>}</p><span className="coming-soon">{featuredInsight ? featuredInsight.health : "WAITING"}</span></div></div>
  </>;
}

function MetricCard({ label, value, note, icon, tone }: { label: string; value: string | number; note: string; icon: ReactNode; tone: string }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-note">{note}</span></article>;
}

function HivesView({ hives, onAdd, onSimulate }: { hives: Hive[]; onAdd: () => void; onSimulate: (hive: Hive) => void }) {
  return <>
    <PageHeading eyebrow="APIARY INVENTORY" title="Your hives" description="Register colonies and keep their field conditions up to date." action={<button className="button button-primary" onClick={onAdd}><Plus size={17} /> Register hive</button>} />
    {hives.length === 0 ? <section className="panel large-empty"><EmptyState icon={<HiveIcon size={24} />} title="Start with your first hive" detail="Add its location and colony details. You can then submit manual or simulated sensor readings." action={<button className="button button-primary" onClick={onAdd}><Plus size={16} /> Register a hive</button>} /></section> : <div className="hives-grid">{hives.map((hive) => <HiveCard key={hive.id} hive={hive} onSimulate={() => onSimulate(hive)} />)}</div>}
  </>;
}

function HiveCard({ hive, onSimulate }: { hive: Hive; onSimulate: () => void }) {
  const latest = hive.readings[0];
  return <article className="hive-card panel"><div className="hive-card-top"><div className="hive-card-icon"><HiveIcon size={20} /></div><span className="health-chip"><i /> MONITORED</span></div><h2>{hive.name}</h2><p className="hive-location"><MapPin size={14} />{hive.location}</p>{hive.colonyType && <span className="colony-tag">{hive.colonyType}</span>}<div className="hive-sensors"><SensorValue icon={<Thermometer size={15} />} label="TEMP" value={latest ? `${latest.temperatureC}°C` : "—"} /><SensorValue icon={<Wind size={15} />} label="HUMIDITY" value={latest ? `${latest.humidityPct}%` : "—"} /><SensorValue icon={<Weight size={15} />} label="WEIGHT" value={latest ? `${latest.weightKg} kg` : "—"} /></div><div className="hive-card-bottom"><span>{formatDate(latest?.recordedAt)}</span><button className="button button-light small-button" onClick={onSimulate}><Activity size={15} /> Sample sensors</button></div></article>;
}

function SensorValue({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="sensor-value"><span>{icon}{label}</span><strong>{value}</strong></div>;
}

function HiveRow({ hive, onSimulate }: { hive: Hive; onSimulate: () => void }) {
  const latest = hive.readings[0];
  return <div className="hive-row"><div className="hive-row-symbol"><HiveIcon size={17} /></div><div className="hive-row-name"><strong>{hive.name}</strong><span><MapPin size={12} />{hive.location}</span></div><div className="hive-row-stat"><Thermometer size={15} /><strong>{latest ? `${latest.temperatureC}°` : "—"}</strong></div><div className="hive-row-stat humidity-stat"><Wind size={15} /><strong>{latest ? `${latest.humidityPct}%` : "—"}</strong></div><button className="icon-button sample-button" title="Generate simulated reading" onClick={onSimulate}><RefreshCw size={15} /></button></div>;
}

function ReadingRow({ reading }: { reading: SensorReading }) {
  return <div className="reading-row"><span className="reading-origin"><i />{reading.source === "SIMULATOR" ? "SIM" : reading.source}</span><div className="reading-row-name"><strong>{reading.hive?.name ?? "Hive"}</strong><span>{formatDate(reading.recordedAt)}</span></div><div className="reading-values"><span><Thermometer size={13} />{reading.temperatureC}°</span><span><Wind size={13} />{reading.humidityPct}%</span></div></div>;
}

function BatchesView({ batches, hives, onAdd, onHistory, onQr, onAdvance, onRecordStage }: { batches: Batch[]; hives: Hive[]; onAdd: () => void; onHistory: (batch: Batch) => void; onQr: (batch: Batch) => void; onAdvance: (batch: Batch, status: "PROCESSING" | "SUBMITTED_FOR_VERIFICATION") => void; onRecordStage: (batch: Batch, type: Exclude<BatchStageType, "HARVESTED" | "VERIFIED" | "CONSUMER_VERIFIED">) => void }) {
  return <>
    <PageHeading eyebrow="HARVEST PROVENANCE" title="Honey batches" description="Every harvest gets a unique code, a history and a consumer verification link." action={<button className="button button-primary" onClick={onAdd} disabled={!hives.length}><Plus size={17} /> Record harvest</button>} />
    <section className="panel batches-panel full-batches-panel">{batches.length ? <BatchTable batches={batches} onHistory={onHistory} onQr={onQr} onAdvance={onAdvance} onRecordStage={onRecordStage} /> : <EmptyState icon={<Boxes size={22} />} title={hives.length ? "Your first batch starts here" : "Register a hive before recording harvest"} detail={hives.length ? "Select a hive, enter harvest quantity and create its traceability record." : "Harvests are tied to their source hive to preserve provenance."} action={hives.length ? <button className="button button-primary" onClick={onAdd}><Plus size={16} /> Record harvest</button> : undefined} />}</section>
  </>;
}

function VerifierQueue({ batches, onReview }: { batches: Batch[]; onReview: (batch: Batch) => void }) {
  return <>
    <PageHeading eyebrow="LABORATORY REVIEW" title="Verifier queue" description="Review submitted batch records after their on-chain digest has been checked." />
    <section className="panel verifier-panel">
      {batches.length === 0 ? <EmptyState icon={<BadgeCheck size={22} />} title="No batches awaiting review" detail="Batches submitted by beekeepers will appear here." /> : <div className="review-list">{batches.map((batch) => <article className="review-row" key={batch.id}><div className="review-code"><strong>{batch.code}</strong><span>{batch.quantityKg} kg · {batch.hive?.name} · {batch.floralSource || "Floral source not recorded"}</span></div><div className="review-owner"><span>{batch.beekeeper?.name ?? "Beekeeper"}</span><small>{formatDate(batch.harvestDate, true)}</small></div><span className="chain-status anchored"><i />Anchored</span><button className="button button-light small-button" onClick={() => onReview(batch)}>Review batch <ArrowUpRight size={14} /></button></article>)}</div>}
    </section>
  </>;
}

function BatchTable({ batches, onHistory, onQr, onAdvance, onRecordStage }: { batches: Batch[]; onHistory: (batch: Batch) => void; onQr: (batch: Batch) => void; onAdvance?: (batch: Batch, status: "PROCESSING" | "SUBMITTED_FOR_VERIFICATION") => void; onRecordStage?: (batch: Batch, type: Exclude<BatchStageType, "HARVESTED" | "VERIFIED" | "CONSUMER_VERIFIED">) => void }) {
  return <div className="table-wrap"><table><thead><tr><th>BATCH</th><th>HIVE / SOURCE</th><th>HARVESTED</th><th>QUANTITY</th><th>CHAIN STATUS</th>{(onAdvance || onRecordStage) && <th>NEXT STEP</th>}<th aria-label="Actions" /></tr></thead><tbody>{batches.map((batch) => {
    const nextStatus = batch.status === "CREATED" ? "PROCESSING" : batch.status === "PROCESSING" ? "SUBMITTED_FOR_VERIFICATION" : null;
    const nextLabel = nextStatus === "PROCESSING" ? "Start processing" : nextStatus === "SUBMITTED_FOR_VERIFICATION" ? "Submit for review" : null;
    const latestStage = batch.stages?.at(-1)?.type;
    const nextStage: Exclude<BatchStageType, "HARVESTED" | "VERIFIED" | "CONSUMER_VERIFIED"> | null = batch.status === "VERIFIED" && (!latestStage || latestStage === "VERIFIED") ? "PROCESSED" : latestStage === "PROCESSED" ? "PACKAGED" : latestStage === "PACKAGED" ? "DISTRIBUTED" : null;
    const stageLabels = { PROCESSED: "Record processing", PACKAGED: "Record packaging", DISTRIBUTED: "Record dispatch" };
    return <tr key={batch.id}><td><button className="batch-code" onClick={() => onHistory(batch)}>{batch.code}<span>{batch.status.replaceAll("_", " ")}</span></button></td><td><strong className="table-primary">{batch.hive?.name ?? "Hive"}</strong><span className="table-secondary">{batch.floralSource || "Floral source not recorded"}</span></td><td>{formatDate(batch.harvestDate, true)}</td><td>{batch.quantityKg} kg</td><td><span className={`chain-status ${batch.blockchainTx ? "anchored" : "local"}`}><i />{batch.blockchainTx ? "Anchored" : "Local record"}</span></td>{(onAdvance || onRecordStage) && <td>{nextStatus && nextLabel ? <button className="workflow-button" onClick={() => onAdvance?.(batch, nextStatus)}>{nextLabel}</button> : nextStage && onRecordStage ? <button className="workflow-button" onClick={() => onRecordStage(batch, nextStage)}>{stageLabels[nextStage]}</button> : <span className="table-secondary">{batch.status.replaceAll("_", " ")}</span>}</td>}<td><div className="table-actions"><button className="icon-button" title="View batch history" onClick={() => onHistory(batch)}><ClipboardList size={16} /></button><button className="icon-button" title="Show verification QR" onClick={() => onQr(batch)}><QrCode size={16} /></button></div></td></tr>;
  })}</tbody></table></div>;
}

function EmptyState({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><p>{detail}</p>{action}</div>;
}

function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true">{children}</section></div>;
}

function FormModal({ title, description, onCancel, children, onSubmit, submitLabel }: { title: string; description: string; onCancel: () => void; children: ReactNode; onSubmit: (event: FormEvent<HTMLFormElement>) => void; submitLabel: string }) {
  return <form onSubmit={onSubmit} className="modal-form"><div className="modal-heading"><div><p className="eyebrow">FIELD ENTRY</p><h2>{title}</h2><p className="muted">{description}</p></div><button type="button" className="icon-button" aria-label="Close" onClick={onCancel}><X size={18} /></button></div><div className="modal-fields">{children}</div><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onCancel}>Cancel</button><button className="button button-primary">{submitLabel}<ArrowUpRight size={16} /></button></div></form>;
}

function HiveForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    const latitude = String(form.get("latitude") ?? "");
    const longitude = String(form.get("longitude") ?? "");
    try {
      await api("/hives", { method: "POST", body: JSON.stringify({ name: form.get("name"), location: form.get("location"), colonyType: form.get("colonyType") || undefined, notes: form.get("notes") || undefined, latitude: latitude ? Number(latitude) : undefined, longitude: longitude ? Number(longitude) : undefined }) });
      onCreated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not register hive"); } finally { setBusy(false); }
  }
  return <FormModal title="Register a hive" description="Add the source colony for sensor readings and harvest records." onCancel={onCancel} onSubmit={submit} submitLabel={busy ? "Saving…" : "Register hive"}><label>Hive name<input name="name" placeholder="North orchard · Hive 01" minLength={2} required /></label><label>Location<input name="location" placeholder="Village, district" minLength={2} required /></label><label>Colony type <span className="optional-label">OPTIONAL</span><input name="colonyType" placeholder="e.g. Apis mellifera" /></label><div className="form-pair"><label>Latitude <span className="optional-label">OPTIONAL</span><input name="latitude" type="number" min="-90" max="90" step="any" placeholder="e.g. 12.9716" /></label><label>Longitude <span className="optional-label">OPTIONAL</span><input name="longitude" type="number" min="-180" max="180" step="any" placeholder="e.g. 77.5946" /></label></div><label>Field notes <span className="optional-label">OPTIONAL</span><textarea name="notes" rows={2} placeholder="Placement, forage or inspection notes" /></label>{error && <p className="form-error" role="alert">{error}</p>}</FormModal>;
}

function BatchForm({ hives, onCancel, onCreated }: { hives: Hive[]; onCancel: () => void; onCreated: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await api("/batches", { method: "POST", body: JSON.stringify({ hiveId: form.get("hiveId"), harvestDate: form.get("harvestDate"), quantityKg: Number(form.get("quantityKg")), floralSource: form.get("floralSource") || undefined }) });
      onCreated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not record harvest"); } finally { setBusy(false); }
  }
  return <FormModal title="Record a harvest" description="Create a batch linked to its hive and harvest details." onCancel={onCancel} onSubmit={submit} submitLabel={busy ? "Saving…" : "Create batch"}><label>Source hive<select name="hiveId" required defaultValue=""><option value="" disabled>Select a registered hive</option>{hives.map((hive) => <option key={hive.id} value={hive.id}>{hive.name} · {hive.location}</option>)}</select></label><div className="form-pair"><label>Harvest date<input name="harvestDate" type="date" max={new Date().toISOString().slice(0, 10)} defaultValue={new Date().toISOString().slice(0, 10)} required /></label><label>Quantity harvested<input name="quantityKg" type="number" min="0.01" max="10000" step="0.01" placeholder="e.g. 18.5" required /></label></div><label>Floral source <span className="optional-label">OPTIONAL</span><input name="floralSource" placeholder="e.g. Mustard, eucalyptus" /></label><div className="form-info"><ShieldCheck size={16} /><span>A digest of these batch details is prepared for blockchain anchoring. Full records stay in HoneyChain.</span></div>{error && <p className="form-error" role="alert">{error}</p>}</FormModal>;
}

function ReviewForm({ batch, onCancel, onReviewed }: { batch: Batch; onCancel: () => void; onReviewed: () => void }) {
  const [decision, setDecision] = useState<"VERIFIED" | "REJECTED">("VERIFIED");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await api(`/verifier/batches/${encodeURIComponent(batch.code)}/decision`, { method: "PATCH", body: JSON.stringify({ decision, note: form.get("note") }) });
      onReviewed();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the review"); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="modal-form"><div className="modal-heading"><div><p className="eyebrow">VERIFIER REVIEW</p><h2>{batch.code}</h2><p className="muted">{batch.quantityKg} kg · {batch.hive?.name} · {batch.beekeeper?.name}</p></div><button type="button" className="icon-button" aria-label="Close" onClick={onCancel}><X size={18} /></button></div><div className="modal-fields"><label>Review outcome<select value={decision} onChange={(event) => setDecision(event.target.value as "VERIFIED" | "REJECTED")}><option value="VERIFIED">Verify batch</option><option value="REJECTED">Reject batch</option></select></label><label>Review note<textarea name="note" minLength={8} maxLength={500} rows={4} placeholder="Record the inspection result and evidence" required /></label><div className="form-info"><ShieldCheck size={16} /><span>Approval is recorded only when batch data matches its blockchain digest. Your decision and note become part of the batch history.</span></div>{error && <p className="form-error" role="alert">{error}</p>}</div><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : decision === "VERIFIED" ? "Verify batch" : "Reject batch"}<ArrowUpRight size={16} /></button></div></form>;
}

function StageTimeline({ stages, publicView = false, batchCode }: { stages: BatchStage[]; publicView?: boolean; batchCode?: string }) {
  const [verified, setVerified] = useState(false);
  const [actionError, setActionError] = useState("");
  const labels: Record<BatchStageType, string> = {
    HARVESTED: "Harvest recorded", VERIFIED: "Verifier approval", PROCESSED: "Processing", PACKAGED: "Packaging", DISTRIBUTED: "Distribution", CONSUMER_VERIFIED: "Consumer verification",
  };
  const icons: Record<BatchStageType, ReactNode> = {
    HARVESTED: <Flower2 size={16} />, VERIFIED: <BadgeCheck size={16} />, PROCESSED: <Factory size={16} />, PACKAGED: <Package size={16} />, DISTRIBUTED: <Truck size={16} />, CONSUMER_VERIFIED: <ShieldCheck size={16} />,
  };
  async function confirmConsumerVerification() {
    if (!batchCode) return;
    setActionError("");
    try {
      await api(`/public/batches/${encodeURIComponent(batchCode)}/verify`, { method: "POST" });
      setVerified(true);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not record consumer verification");
    }
  }
  return <div className={`stage-timeline ${publicView ? "public-timeline" : ""}`}>{stages.map((stage) => <article className="stage-item" key={`${stage.sequence}-${stage.type}`}>
    <span className="stage-icon">{icons[stage.type]}</span>
    <div className="stage-copy"><strong>{labels[stage.type]}</strong><time>{formatDate(stage.occurredAt)}</time>
      {Object.entries(stage.metadata).map(([key, value]) => <p key={key}>{key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}: {String(value)}</p>)}
      {!publicView && stage.actorId && <small>Recorded by account · {stage.actorId.slice(0, 8)}</small>}
      {stage.proof && <small className={stage.proof.verified ? "proof-valid" : "proof-pending"}>{stage.proof.verified ? "Blockchain proof confirmed" : "Blockchain proof unavailable"}</small>}
    </div>
  </article>)}{publicView && batchCode && stages.at(-1)?.type === "DISTRIBUTED" && <div className="consumer-verify-action"><button className="button button-light consumer-verify-button" disabled={verified} onClick={() => void confirmConsumerVerification()}>{verified ? "Consumer verification recorded" : "Confirm consumer verification"}<ShieldCheck size={15} /></button>{actionError && <small role="alert">{actionError}</small>}</div>}</div>;
}

function StageForm({ batch, type, onCancel, onSaved }: { batch: Batch; type: Exclude<BatchStageType, "HARVESTED" | "VERIFIED" | "CONSUMER_VERIFIED">; onCancel: () => void; onSaved: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    const dateField = type === "PROCESSED" ? "processedAt" : type === "PACKAGED" ? "packagedAt" : "distributedAt";
    const payload = type === "PROCESSED"
      ? { type, [dateField]: form.get(dateField), method: form.get("method"), quantityKg: Number(form.get("quantityKg")), notes: form.get("notes") || undefined }
      : type === "PACKAGED"
        ? { type, [dateField]: form.get(dateField), packageType: form.get("packageType") || undefined, lotIdentifier: form.get("lotIdentifier") || undefined, quantityKg: Number(form.get("quantityKg")), notes: form.get("notes") || undefined }
        : { type, [dateField]: form.get(dateField), destination: form.get("destination"), quantityKg: Number(form.get("quantityKg")), notes: form.get("notes") || undefined };
    try {
      await api(`/batches/${encodeURIComponent(batch.code)}/stages`, { method: "POST", body: JSON.stringify(payload) });
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not record this stage"); } finally { setBusy(false); }
  }
  const title = type === "PROCESSED" ? "Record processing" : type === "PACKAGED" ? "Record packaging" : "Record distribution";
  const dateName = type === "PROCESSED" ? "processedAt" : type === "PACKAGED" ? "packagedAt" : "distributedAt";
  return <FormModal title={title} description={`Add the next ledger stage for ${batch.code}. Its digest will be anchored separately from operational details.`} onCancel={onCancel} onSubmit={submit} submitLabel={busy ? "Saving…" : "Record stage"}>
    <label>{type === "PROCESSED" ? "Processing date" : type === "PACKAGED" ? "Packaging date" : "Dispatch date"}<input name={dateName} type="date" max={new Date().toISOString().slice(0, 10)} defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
    {type === "PROCESSED" && <label>Processing method<input name="method" minLength={2} maxLength={120} placeholder="e.g. settling and filtration" required /></label>}
    {type === "PACKAGED" && <><label>Package type <span className="optional-label">OPTIONAL</span><input name="packageType" maxLength={120} placeholder="e.g. 500 g glass jar" /></label><label>Lot / package identifier <span className="optional-label">OPTIONAL</span><input name="lotIdentifier" maxLength={100} placeholder="e.g. LOT-24-A" /></label></>}
    {type === "DISTRIBUTED" && <label>Destination<input name="destination" minLength={2} maxLength={160} placeholder="Store, market or delivery region" required /></label>}
    <label>Quantity (kg)<input name="quantityKg" type="number" min="0.01" max={batch.quantityKg} step="0.01" defaultValue={batch.quantityKg} required /></label>
    <label>Notes <span className="optional-label">OPTIONAL</span><textarea name="notes" rows={3} maxLength={500} placeholder="Operational notes" /></label>
    <div className="form-info"><ShieldCheck size={16} /><span>Stage details stay in the database; only a linked digest is recorded on the existing blockchain registry.</span></div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </FormModal>;
}

function BatchHistory({ batch, onQr }: { batch: Batch; onQr: () => void }) {
  return <div className="history-modal"><div className="modal-heading"><div><p className="eyebrow">BATCH HISTORY</p><h2>{batch.code}</h2><p className="muted">{batch.quantityKg} kg · {batch.hive?.name ?? "Hive"} · {formatDate(batch.harvestDate)}</p></div><span className={`chain-status ${batch.blockchainTx ? "anchored" : "local"}`}><i />{batch.blockchainTx ? "On-chain" : "Local"}</span></div>
    {batch.stages?.length ? <><h3 className="ledger-heading">Stage ledger</h3><StageTimeline stages={batch.stages} /></> : <p className="muted">Stage ledger is not available for this batch.</p>}
    <div className="history-list">{batch.events.map((event) => <div className="history-event" key={event.id}><span className="history-marker"><i /></span><div><strong>{event.type.replaceAll("_", " ")}</strong><p>{event.note}</p><time>{formatDate(event.createdAt)}</time></div></div>)}</div><div className="history-footer"><button className="button button-light" onClick={onQr}><QrCode size={16} /> Batch QR</button>{batch.blockchainTx && <span className="transaction-link">Transaction {batch.blockchainTx.slice(0, 12)}…</span>}</div></div>;
}

function BatchQr({ batch }: { batch: Batch }) {
  const verifyUrl = `${window.location.origin}/verify/${encodeURIComponent(batch.code)}`;
  return <div className="qr-modal"><div className="modal-heading"><div><p className="eyebrow">CONSUMER VERIFICATION</p><h2>Batch QR</h2><p className="muted">Scan to view this batch’s provenance.</p></div></div><div className="qr-card"><QRCodeSVG value={verifyUrl} size={208} level="M" includeMargin fgColor="#193d30" /></div><strong className="qr-code-label">{batch.code}</strong><a className="qr-url" href={verifyUrl}>{verifyUrl}</a><p className="qr-note"><ScanLine size={15} /> QR opens the public batch verification page.</p></div>;
}

function PublicVerification() {
  const { code = "" } = useParams();
  const [batch, setBatch] = useState<PublicBatch | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<PublicBatch>(`/public/batches/${encodeURIComponent(code)}`).then(setBatch).catch((cause) => setError(cause instanceof Error ? cause.message : "Batch could not be verified")).finally(() => setLoading(false));
  }, [code]);

  return <main className="verify-page"><header className="verify-header"><Link to="/" className="brand-mark"><Hexagon size={21} /><span>HONEYCHAIN</span></Link><span className="public-tag"><ShieldCheck size={14} /> PUBLIC TRACEABILITY</span></header>{loading ? <ScreenLoader /> : error ? <section className="verify-error"><div className="verify-badge invalid"><CircleHelp size={24} /></div><p className="eyebrow">RECORD NOT FOUND</p><h1>We couldn’t find this batch.</h1><p>{error}</p><Link className="button button-primary" to="/">Return to HoneyChain</Link></section> : batch && <div className="verify-content"><section className="verify-hero"><div><p className="eyebrow">HONEY BATCH · {batch.code}</p><h1>Traceable from<br /><em>hive to harvest.</em></h1><p>Recorded {formatDate(batch.harvestDate)} by a registered beekeeper.</p></div><BatchDecisionBadge batch={batch} /></section><section className="verify-facts"><Fact label="SOURCE HIVE" value={batch.hive.name} detail="Registered source hive" icon={<HiveIcon size={17} />} /><Fact label="HARVEST QUANTITY" value={`${batch.quantityKg} kg`} detail="Recorded at harvest" icon={<Weight size={17} />} /><Fact label="FLORAL SOURCE" value={batch.floralSource || "Not recorded"} detail="Forage information" icon={<Flower2 size={17} />} /><Fact label="BATCH DECISION" value={batch.status.replaceAll("_", " ")} detail="Laboratory review status" icon={<BadgeCheck size={17} />} /><Fact label="INTEGRITY CHECK" value={batch.chainVerified ? "Digest confirmed" : batch.verification === "CHAIN_MISMATCH" ? "Digest mismatch" : "Chain anchor unavailable"} detail={batch.blockchainTx ? `Tx ${batch.blockchainTx.slice(0, 12)}…` : "No blockchain proof attached"} icon={<ShieldCheck size={17} />} /></section><section className="verify-history"><div className="panel-heading"><div><span className="section-kicker">PROVENANCE RECORD</span><h2>Batch history</h2></div><span className="public-tag"><ScanLine size={14} /> READ-ONLY</span></div><div className="history-list">{batch.events.map((event, index) => <div className="history-event" key={`${event.type}-${event.createdAt}`}><span className="history-marker"><i /></span><div><strong>{event.type.replaceAll("_", " ")}</strong><p>{event.note}</p><time>{formatDate(event.createdAt)}</time></div>{index === 0 && <span className="origin-tag">ORIGIN</span>}</div>)}</div></section><footer className="verify-footer"><Hexagon size={17} /><span>HoneyChain · Batch provenance record</span><span>Public data only</span></footer></div>}</main>;
}

function BatchDecisionBadge({ batch }: { batch: PublicBatch }) {
  return <><ChainProofBadge batch={batch} /><StageTimeline stages={batch.stages} publicView batchCode={batch.code} /></>;
}

function ChainProofBadge({ batch }: { batch: PublicBatch }) {
  const proofMismatch = batch.verification === "OFFCHAIN_TAMPERED" || batch.verification === "CHAIN_MISMATCH";
  const verified = batch.status === "VERIFIED" && batch.chainVerified === true && batch.verification === "VERIFIED_ON_CHAIN";
  const rejected = batch.status === "REJECTED" && batch.chainVerified === true;
  const label = proofMismatch ? "PROOF MISMATCH" : verified ? "VERIFIED" : rejected ? "REJECTED" : batch.chainVerified ? "CHAIN CHECKED" : "RECORD FOUND";
  return <div className="decision-proof"><div className={`verify-badge ${proofMismatch || rejected ? "rejected" : verified ? "valid" : "pending"}`}>{proofMismatch || rejected ? <CircleX size={27} /> : verified ? <BadgeCheck size={27} /> : <ShieldCheck size={27} />}<span>{label}</span></div>{batch.chainProof && <dl className="chain-proof"><div><dt>NETWORK</dt><dd>{batch.chainProof.network}</dd></div><div><dt>CONTRACT</dt><dd title={batch.chainProof.contractAddress ?? "Unavailable"}>{batch.chainProof.contractAddress ?? "Unavailable"}</dd></div><div><dt>TRANSACTION</dt><dd title={batch.chainProof.transactionHash ?? "Unavailable"}>{batch.chainProof.transactionHash ?? "Unavailable"}</dd></div><div><dt>ON-CHAIN DIGEST</dt><dd title={batch.chainProof.dataDigest}>{batch.chainProof.dataDigest}</dd></div><div><dt>RECORDED BY</dt><dd title={batch.chainProof.recordedBy}>{batch.chainProof.recordedBy}</dd></div><div><dt>ANCHORED</dt><dd>{formatDate(batch.chainProof.recordedAt)}</dd></div></dl>}</div>;
}

function Fact({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: ReactNode }) {
  return <article className="fact-card"><span className="fact-icon">{icon}</span><span className="section-kicker">{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

export default App;