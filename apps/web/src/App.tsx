// Phase-0 placeholder. The real cache-first map UI is designed in M1.
export function App() {
  return (
    <main style={{ font: "15px/1.5 system-ui", maxWidth: 640, margin: "10vh auto", padding: 24 }}>
      <h1 style={{ margin: 0 }}>aprscaching.com</h1>
      <p style={{ color: "#666" }}>Reborn — APRS Caching workbench. Scaffold ready; map lands in M1.</p>
      <ul>
        <li>Worker API: <code>/health</code>, <code>/ingest</code>, <code>/api/caches</code>, <code>/api/logs/find</code></li>
        <li>Live WS: <code>/ws?region=…</code> (Durable Object, hibernating)</li>
        <li>Verification tiers: A=RF-corroborated · B=app-corroborated · C=IS-only</li>
      </ul>
    </main>
  );
}
