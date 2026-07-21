import type { CSSProperties } from 'react';

type FieldStyle = CSSProperties & {
  '--x'?: string;
  '--y'?: string;
  '--z'?: string;
  '--delay'?: string;
  '--scale'?: string;
  '--opacity'?: string;
};

const nodes = [
  { id: 'telemetry', label: 'telemetry', x: '12%', y: '74%', z: '22px', delay: '0ms' },
  { id: 'envelope', label: 'envelope', x: '33%', y: '48%', z: '58px', delay: '220ms' },
  { id: 'drill', label: 'drill', x: '53%', y: '64%', z: '92px', delay: '440ms' },
  { id: 'mrv', label: 'mrv', x: '68%', y: '35%', z: '126px', delay: '660ms' },
  { id: 'passport', label: 'passport', x: '83%', y: '18%', z: '164px', delay: '880ms' },
] as const;

const meterBars = Array.from({ length: 72 }, (_, index) => {
  const wave = Math.sin(index * 0.31) * 0.22;
  const envelope = Math.exp(-Math.pow((index - 38) / 23, 2)) * 0.62;
  return {
    id: index,
    scale: Math.max(0.12, 0.17 + envelope + wave).toFixed(3),
    opacity: Math.min(0.95, 0.3 + envelope).toFixed(3),
  };
});

export function AssuranceField() {
  return (
    <>
      <figure
        className="mk-field"
        aria-labelledby="assurance-field-title"
        aria-describedby="assurance-field-description"
      >
        <div className="mk-field__halo" aria-hidden="true" />
        <div className="mk-field__viewport" aria-hidden="true">
          <div className="mk-field__scene">
            <div className="mk-field__plane" />
            <div className="mk-field__rail mk-field__rail--a" />
            <div className="mk-field__rail mk-field__rail--b" />
            {nodes.map((node, index) => (
              <div
                className="mk-field__node"
                key={node.id}
                style={
                  {
                    '--x': node.x,
                    '--y': node.y,
                    '--z': node.z,
                    '--delay': node.delay,
                  } as FieldStyle
                }
              >
                <span className="mk-field__tower" />
                <span className="mk-field__core" />
                {index < nodes.length - 1 ? <span className="mk-field__packet" /> : null}
              </div>
            ))}
          </div>
        </div>

        <div className="mk-field__callout mk-field__callout--telemetry">
          <span>TELEMETRY</span>
          <strong>APPEND ONLY</strong>
        </div>
        <div className="mk-field__callout mk-field__callout--control">
          <span>CONTROL</span>
          <strong>OPERATOR ARMED</strong>
        </div>
        <div className="mk-field__callout mk-field__callout--evidence">
          <span>EVIDENCE</span>
          <strong>SHA-256</strong>
        </div>
        <div className="mk-field__callout mk-field__callout--status">
          <span>STATUS</span>
          <strong>SIMULATED FACILITY</strong>
        </div>

        <figcaption>
          <span id="assurance-field-title">FLEXIBILITY FIELD</span>
          <span id="assurance-field-description">
            A three-dimensional assurance chain from telemetry to an immutable passport.
          </span>
        </figcaption>
      </figure>

      <aside className="mk-meter" aria-label="Assurance chain readout">
        <p>INPUT · READ-ONLY TELEMETRY</p>
        <div className="mk-meter__bars" aria-hidden="true">
          {meterBars.map((bar) => (
            <span
              key={bar.id}
              style={
                {
                  '--scale': bar.scale,
                  '--opacity': bar.opacity,
                } as FieldStyle
              }
            />
          ))}
        </div>
        <p>OUTPUT · SEALED EVIDENCE</p>
      </aside>
    </>
  );
}
