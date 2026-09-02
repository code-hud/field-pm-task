import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell } from './components/AppShell.jsx';
import { LoadingState } from './components/States.jsx';
import { useAuth } from './context/AuthContext.jsx';
import { StockPage } from './pages/StockPage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { MarketsPage } from './pages/MarketsPage.jsx';
import { OrdersPage } from './pages/OrdersPage.jsx';
import { PortfolioPage } from './pages/PortfolioPage.jsx';

function RequireAuth({ children }) {
  const { isAuthenticated, status } = useAuth();
  const location = useLocation();

  // Hold the route while a stored token is being validated, so a refresh doesn't
  // bounce an authenticated user through the login screen.
  if (status === 'restoring') return <LoadingState label="Restoring your session" height={320} />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/markets" element={<MarketsPage />} />
        <Route path="/markets/:symbol" element={<StockPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/portfolio" replace />} />
    </Routes>
  );
}
