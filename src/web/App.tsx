import { useEffect, useState } from 'react';
import { errorText, refreshAuth } from './app/api';
import { tabOf, useRoute, type Route } from './app/router';
import { useApp } from './app/store';
import { StepUpSheet, TabBar, Toasts } from './ui/chrome';
import { Button, Notice, Spinner } from './ui/primitives';
import { AiScreen } from './screens/Ai';
import { AssetScreen } from './screens/Asset';
import { LoginScreen, SetupScreen } from './screens/Auth';
import { DashboardScreen } from './screens/Dashboard';
import { ActivityScreen, JournalScreen } from './screens/Journal';
import { MarketScreen } from './screens/Market';
import { AboutScreen, BacktestScreen, MoreScreen, SecurityScreen } from './screens/More';
import { PortfolioScreen } from './screens/Portfolio';
import { RiskScreen } from './screens/Risk';
import { RunDetailScreen } from './screens/RunDetail';
import { SettingsScreen } from './screens/Settings';

function screenFor(route: Route) {
  switch (route.name) {
    case 'home':
      return <DashboardScreen />;
    case 'market':
      return <MarketScreen />;
    case 'asset':
      return <AssetScreen key={route.id} id={route.id} />;
    case 'ai':
      return <AiScreen />;
    case 'run':
      return <RunDetailScreen key={route.id} id={route.id} />;
    case 'portfolio':
      return <PortfolioScreen />;
    case 'more':
      return <MoreScreen />;
    case 'journal':
      return <JournalScreen />;
    case 'activity':
      return <ActivityScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'risk':
      return <RiskScreen />;
    case 'security':
      return <SecurityScreen />;
    case 'backtest':
      return <BacktestScreen />;
    case 'about':
      return <AboutScreen />;
  }
}

export function App() {
  const auth = useApp((s) => s.auth);
  const route = useRoute();
  const [bootError, setBootError] = useState<string | null>(null);

  const boot = () => {
    setBootError(null);
    refreshAuth().catch((err: unknown) => setBootError(errorText(err) ?? 'Serveur injoignable'));
  };
  useEffect(boot, []);

  // Each navigation starts at the top, like a native push.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.name, 'id' in route ? route.id : null]);

  let content;
  if (!auth) {
    content = bootError ? (
      <main className="auth">
        <div className="auth-card stack">
          <Notice tone="bad" title="Connexion au serveur impossible">
            {bootError}
          </Notice>
          <Button variant="primary" onClick={boot}>
            Réessayer
          </Button>
        </div>
      </main>
    ) : (
      <main className="splash" aria-busy="true">
        <img src="/icons/icon.svg" alt="" width={72} height={72} />
        <Spinner label="Chargement" />
      </main>
    );
  } else if (!auth.installed) {
    content = <SetupScreen status={auth} />;
  } else if (!auth.authenticated) {
    content = <LoginScreen />;
  } else {
    content = (
      <>
        {screenFor(route)}
        <TabBar active={tabOf(route)} />
        <StepUpSheet />
      </>
    );
  }

  return (
    <>
      {content}
      <Toasts />
    </>
  );
}
