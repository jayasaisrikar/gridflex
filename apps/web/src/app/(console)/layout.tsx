import type { ReactNode } from 'react';
import { Rail } from '@/components/rail';

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <Rail />
      <div className="main">
        {/*
          Spec 11 / 24: simulated data must be unmistakably labelled everywhere
          it appears. Not dismissible while the facility is on the simulator.
        */}
        <div className="simbar" role="status">
          <span aria-hidden="true">◈</span>
          <span>
            SIMULATED — Lone Star Compute Facility is running the deterministic
            simulator. No value on this screen comes from physical equipment.
          </span>
        </div>
        {children}
        <footer className="foot-line">
          <span>GridFlex V1 · stages 1–3 of the trust ladder</span>
          <span>engine gridflex-envelope-1.0.0</span>
          <span>mrv gridflex-mrv-1.0.0</span>
          <span>canonical gridflex-canonical-1</span>
        </footer>
      </div>
    </div>
  );
}
