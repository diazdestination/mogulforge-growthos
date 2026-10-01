import { createRoot } from 'react-dom/client';
import { setBeforeLogoutHandler } from '@workspace/replit-auth-web';
import { revokeCurrentDevicePush } from '@/lib/staff-push';

import App from './App';

import './index.css';

setBeforeLogoutHandler(revokeCurrentDevicePush);

createRoot(document.getElementById('root')!).render(<App />);
