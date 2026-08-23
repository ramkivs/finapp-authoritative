import React, { useState } from 'react';
import { CalculationProvenance } from '../../domain/mathematics/types';
import { ShieldCheck, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react';

interface Props {
  provenance: CalculationProvenance;
  className?: string;
}

export const ProvenanceBadge: React.FC<Props> = ({ provenance, className = '' }) => {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const copyFingerprint = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(provenance.executionFingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const shortHash = provenance.executionFingerprint
    ? `${provenance.executionFingerprint.slice(0, 8)}...${provenance.executionFingerprint.slice(-6)}`
    : 'Deterministic';

  return (
    <div className={`rounded-xl border border-[#21262D]/60 bg-[#0D1117] overflow-hidden text-xs ${className}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-[#161B22] transition text-left cursor-pointer outline-none"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-[#23C55E]" />
          <span className="font-bold text-[11px] text-[#F0F6FC]">
            Institutional Mathematical Provenance
          </span>
          <span className="px-1.5 py-0.2 rounded bg-green-950/40 border border-green-800/30 text-[9px] font-bold text-[#23C55E]">
            Verified Deterministic
          </span>
        </div>

        <div className="flex items-center gap-2">
          <code className="text-[10px] font-mono text-[#8B949E] bg-[#161B22] px-1.5 py-0.5 rounded border border-[#21262D]/60">
            {shortHash}
          </code>
          {expanded ? <ChevronUp size={14} className="text-[#8B949E]" /> : <ChevronDown size={14} className="text-[#8B949E]" />}
        </div>
      </button>

      {expanded && (
        <div className="p-3 border-t border-[#21262D]/60 bg-[#161B22]/50 space-y-2 text-[11px]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[#8B949E]">
            <div>
              <span className="font-semibold text-[#6E7681] block text-[10px] uppercase">Engine ID</span>
              <span className="text-[#F0F6FC] font-mono text-[10px]">{provenance.engineId}</span>
            </div>
            <div>
              <span className="font-semibold text-[#6E7681] block text-[10px] uppercase">Algorithm ID & Version</span>
              <span className="text-[#F0F6FC] font-mono text-[10px]">{provenance.algorithmId} (v{provenance.algorithmVersion})</span>
            </div>
            {provenance.policyContractId && (
              <div>
                <span className="font-semibold text-[#6E7681] block text-[10px] uppercase">Statutory Policy</span>
                <span className="text-[#F0F6FC] font-mono text-[10px]">{provenance.policyContractId} {provenance.policyVersion ? `(v${provenance.policyVersion})` : ''}</span>
              </div>
            )}
            <div>
              <span className="font-semibold text-[#6E7681] block text-[10px] uppercase">Reference Standard</span>
              <span className="text-[#F0F6FC] font-semibold text-[10px]">{provenance.referenceType}</span>
            </div>
          </div>

          {provenance.citation && (
            <div className="pt-1.5 border-t border-[#21262D]/40">
              <span className="font-semibold text-[#6E7681] block text-[10px] uppercase">Mathematical Citation</span>
              <p className="text-[10px] text-[#8B949E] italic">{provenance.citation}</p>
            </div>
          )}

          <div className="pt-1.5 border-t border-[#21262D]/40 flex items-center justify-between">
            <div className="overflow-hidden pr-2">
              <span className="font-semibold text-[#6E7681] block text-[9px] uppercase">Execution Fingerprint (RFC 8785 JCS, deterministic digest)</span>
              <code className="text-[9px] font-mono text-[#4F8CFF] block truncate">
                {provenance.executionFingerprint}
              </code>
            </div>
            <button
              type="button"
              onClick={copyFingerprint}
              className="px-2 py-1 rounded bg-[#0D1117] hover:bg-[#21262D] text-[#8B949E] hover:text-[#F0F6FC] text-[10px] font-bold border border-[#21262D] transition flex items-center gap-1 shrink-0 cursor-pointer"
            >
              {copied ? <Check size={11} className="text-[#23C55E]" /> : <Copy size={11} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
