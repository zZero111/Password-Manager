import { Unlock, Welcome } from "./components/Auth";
import { VaultScreen } from "./components/VaultScreen";
import { useVault } from "./lib/useVault";

export function App() {
  const vault = useVault();
  switch (vault.phase) {
    case "loading":
      return <div className="auth muted">Loading…</div>;
    case "signedOut":
      return <Welcome vault={vault} />;
    case "locked":
      return <Unlock vault={vault} />;
    case "unlocked":
      return <VaultScreen vault={vault} />;
  }
}
