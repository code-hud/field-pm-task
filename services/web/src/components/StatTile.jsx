import { Delta } from './Delta.jsx';

/**
 * Stat tile: label · value · optional delta · optional footnote.
 * Values use proportional figures — tabular-nums makes a big standalone number
 * look loose. `hero` is for the one number a page leads with.
 */
export function StatTile({ label, value, delta, deltaValue, footnote, hero = false }) {
  return (
    <article className="tile">
      <div className="tile__label">{label}</div>
      <div className={`tile__value${hero ? ' tile__value--hero' : ''}`}>{value}</div>
      {(delta || footnote) && (
        <div className="tile__foot">
          {delta && <Delta value={deltaValue}>{delta}</Delta>}
          {footnote && <span>{footnote}</span>}
        </div>
      )}
    </article>
  );
}
