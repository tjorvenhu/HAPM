/**
 * Der Import als EIN abgekoppelter Lauf.
 *
 * Es gibt keinen zweiten Schreibweg in `haproxy.cfg`. Jeder Eintrag geht durch
 * genau das, was auch der Dialog nimmt: Vorabprüfung (`precheckCreate`,
 * `precheckStreamCreate`) und Anlegen (`createService`, `createStream`), mit
 * Lock, Prüfsumme, Zertifikat, `haproxy -c`, Reload und Rückweg. Eine
 * Sammelfassung, die alle Einträge in einen Text rechnet und einmal neu lädt,
 * wäre schneller und hätte einen Nachteil, der schwerer wiegt: ein einziges
 * Zertifikat, das Let's Encrypt verweigert, nähme alle anderen mit.
 *
 * Deshalb hält ein Fehlschlag die übrigen nicht auf. Ein Eintrag, dessen Domain
 * oder Port inzwischen jemand anders belegt hat, wird übersprungen und nicht
 * als Fehler gezählt: die Lage hat sich geändert, nicht der Eintrag. Am Ende
 * steht eine Zusammenfassung, und ihr Ergebnis bestimmt, ob der Lauf als
 * gescheitert in der Historie steht.
 *
 * Die Gruppe wird vorher angelegt, falls sie neu ist. Scheitert das, gibt es
 * keine Stelle für die Einträge, und der Lauf hört dort auf.
 */

import {
  HaproxyConfigError,
  scopeLabel,
  type CreateServiceInput,
} from './config';
import type { CreateStreamInput } from './streams';
import {
  createService,
  createStream,
  precheckCreate,
  precheckScope,
  precheckStreamCreate,
  updateScopes,
  type ProvisionReporter,
  type ProvisionResult,
  type ProvisionStep,
} from './provision';
import type { ChallengeChoice } from './challenge';
import type { Server } from '../types';

export interface ImportItem {
  key: string;
  /** Wie der Eintrag in den Schritten heißt: Hauptdomain oder Port. */
  title: string;
  /** Ohne ID: sie ergibt sich im Lauf aus der Datei, wie beim Dialog. */
  service: CreateServiceInput | null;
  stream: CreateStreamInput | null;
}

export interface ImportPlan {
  /** Der Name der Gruppe, wie er im Marker steht oder stehen wird. */
  scope: string;
  createScope: boolean;
  items: ImportItem[];
}

export function importTitle(entry: { domains: string[]; port: number | null }): string {
  if (entry.port !== null && entry.domains.length === 0) return `Port ${entry.port}`;
  const more = entry.domains.length - 1;
  return more > 0 ? `${entry.domains[0]} und ${more} weitere` : (entry.domains[0] ?? '?');
}

/** Die Spalte fasst 1024 Zeichen, siehe `describe` im Runner. */
function clip(text: string, max = 1000): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** Was in der Historie unter „Domains" und „Ziele" steht. */
export function describeImport(plan: ImportPlan): { domains: string | null; targets: string | null } {
  const names = plan.items.flatMap((item) =>
    item.service ? item.service.domains : item.stream ? [`Port ${item.stream.port}`] : []
  );
  const count = plan.items.length === 1 ? 'ein Eintrag' : `${plan.items.length} Einträge`;
  return {
    domains: names.length > 0 ? clip(names.join(', ')) : null,
    targets: `${count} in ${scopeLabel(plan.scope)}${plan.createScope ? ' (neue Gruppe)' : ''}`,
  };
}

export function importAuditDetails(plan: ImportPlan, failure: string | null): string {
  const { domains, targets } = describeImport(plan);
  return `Import: ${targets}: ${domains ?? '–'}${failure ? `, fehlgeschlagen: ${failure}` : ''}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Unbekannter Fehler.';
}

export async function runImport(
  server: Server,
  plan: ImportPlan,
  challenge: ChallengeChoice,
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  const done: ProvisionStep[] = [];
  const emit = (steps: ProvisionStep[]) =>
    Promise.resolve(reporter?.onStep?.(steps)).catch(() => {});
  const push = async (...steps: ProvisionStep[]) => {
    done.push(...steps);
    await emit(done);
  };

  /** Die Schritte eines Vorgangs, mit dem Eintrag davor: im Protokoll stehen
   *  sonst dreißigmal „Zertifikat ausgestellt" ohne zu sagen, wofür. */
  const prefixed = (title: string, steps: ProvisionStep[]) =>
    steps.map((step) => ({ ...step, label: `${title}: ${step.label}` }));
  const inner = (title: string): ProvisionReporter => ({
    onPhase: (phase) => reporter?.onPhase?.(phase),
    onStep: (steps) => emit([...done, ...prefixed(title, steps)]),
  });

  /* ── Die Gruppe ── */
  if (plan.createScope) {
    const title = `Gruppe ${scopeLabel(plan.scope)}`;
    try {
      await precheckScope(server, plan.scope, 'add');
      const result = await updateScopes(server, plan.scope, { action: 'add' }, inner(title));
      await push(...prefixed(title, result.steps));
      if (result.steps.some((step) => !step.ok)) {
        await push({
          label: 'Import abgebrochen',
          ok: false,
          detail: 'Die Gruppe ließ sich nicht anlegen. Ohne sie gibt es keine Stelle für die Einträge.',
        });
        return { steps: done };
      }
    } catch (err) {
      await push(
        { label: `${title}: anlegen`, ok: false, detail: message(err) },
        {
          label: 'Import abgebrochen',
          ok: false,
          detail: 'Die Gruppe ließ sich nicht anlegen. Ohne sie gibt es keine Stelle für die Einträge.',
        }
      );
      return { steps: done };
    }
  }

  /* ── Die Einträge, nacheinander ── */
  const created: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const total = plan.items.length;

  for (const [index, item] of plan.items.entries()) {
    const title = `${index + 1}/${total} ${item.title}`;
    try {
      let id: string;
      let result: ProvisionResult;
      try {
        if (item.service) {
          const input = await precheckCreate(server, { ...item.service, scope: plan.scope, id: '' }, challenge);
          id = input.id;
          result = await createService(server, input, challenge, inner(title));
        } else if (item.stream) {
          const input = await precheckStreamCreate(server, { ...item.stream, scope: plan.scope, id: '' });
          id = input.id;
          result = await createStream(server, input, inner(title));
        } else {
          throw new Error('Der Eintrag hat weder Domain noch Port.');
        }
      } catch (err) {
        // Belegt seit der Vorschau: eine Auskunft über die Lage, kein Fehler
        // des Eintrags.
        if (err instanceof HaproxyConfigError) {
          skipped.push(`${item.title}: ${err.message}`);
          await push({ label: `${title}: übersprungen`, ok: true, detail: err.message });
          continue;
        }
        throw err;
      }

      await push(...prefixed(title, result.steps));
      const broken = result.steps.find((step) => !step.ok);
      if (broken) {
        const reason = [broken.label, broken.detail].filter(Boolean).join(': ');
        failed.push(`${item.title}: ${reason}`);
        await push({ label: `${title}: gescheitert`, ok: false, detail: reason });
      } else {
        created.push(`${item.title} (${id})`);
        await push({ label: `${title}: angelegt`, ok: true, detail: `Kennung ${id}` });
      }
    } catch (err) {
      failed.push(`${item.title}: ${message(err)}`);
      await push({ label: `${title}: gescheitert`, ok: false, detail: message(err) });
    }
  }

  const lines = [
    `Angelegt: ${created.length}. Übersprungen: ${skipped.length}. Gescheitert: ${failed.length}.`,
    ...(skipped.length > 0 ? ['', 'Übersprungen:', ...skipped] : []),
    ...(failed.length > 0 ? ['', 'Gescheitert:', ...failed] : []),
  ];
  await push({ label: 'Zusammenfassung', ok: failed.length === 0, detail: lines.join('\n') });
  return { steps: done };
}
