import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { RULE_FIELDS } from '../../shared/rules';
import type {
  Collection,
  CollectionRule,
  Facets,
  Movie,
  RuleField,
  SmartRules,
} from '../../shared/types';
import { api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { useCollectionMutations, useFacets } from '../lib/queries';
import { Icon } from './Icon';
import { useToast } from './Toasts';
import { Button, Chip, Dialog, Field, IconButton, Segmented, Switch } from './ui';
import { SORT_OPTIONS } from '../pages/BrowsePage';

function defaultRule(field: RuleField): CollectionRule {
  switch (field) {
    case 'genre':
    case 'director':
    case 'country':
    case 'tag':
    case 'studio':
    case 'officialRating':
      return { field, op: 'any', values: [] };
    case 'year':
    case 'runtime':
    case 'communityRating':
    case 'personalRating':
      return { field, op: 'between', min: null, max: null };
    case 'watched':
      return { field, op: 'is', value: 'unwatched' };
    case 'favorite':
      return { field, op: 'is', value: true };
    case 'title':
      return { field, op: 'contains', value: '' };
    case 'addedWithinDays':
      return { field, op: 'lte', value: 30 };
  }
}

const FACET_KEY: Partial<Record<RuleField, keyof Facets>> = {
  genre: 'genres',
  director: 'directors',
  country: 'countries',
  tag: 'tags',
  studio: 'studios',
  officialRating: 'ratings',
};

function ValuePicker({
  rule,
  facets,
  onChange,
}: {
  rule: Extract<CollectionRule, { values: string[] }>;
  facets: Facets | undefined;
  onChange: (values: string[]) => void;
}) {
  const [custom, setCustom] = useState('');
  const key = FACET_KEY[rule.field];
  const options = key && facets ? (facets[key] as Facets['genres']).map((f) => f.value) : [];
  const all = [...new Set([...rule.values, ...options])];
  const toggle = (v: string) =>
    onChange(rule.values.includes(v) ? rule.values.filter((x) => x !== v) : [...rule.values, v]);
  return (
    <div className="rule__values">
      <div className="chip-list chip-list--scroll">
        {all.slice(0, 60).map((v) => (
          <Chip key={v} selected={rule.values.includes(v)} onClick={() => toggle(v)}>
            {v}
          </Chip>
        ))}
        {all.length === 0 && (
          <span className="faint">No values in your library yet — type one below.</span>
        )}
      </div>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = custom.trim();
          if (v && !rule.values.includes(v)) onChange([...rule.values, v]);
          setCustom('');
        }}
      >
        <input
          className="input input--sm"
          placeholder="Add another value"
          aria-label={`Add ${RULE_FIELDS[rule.field].label.toLowerCase()} value`}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!custom.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}

function RuleRow({
  rule,
  facets,
  onChange,
  onRemove,
}: {
  rule: CollectionRule;
  facets: Facets | undefined;
  onChange: (rule: CollectionRule) => void;
  onRemove: () => void;
}) {
  const kind = RULE_FIELDS[rule.field].kind;
  return (
    <li className="rule">
      <div className="rule__head">
        <label className="select select--sm">
          <span className="visually-hidden">Rule field</span>
          <select
            value={rule.field}
            onChange={(e) => onChange(defaultRule(e.target.value as RuleField))}
          >
            {Object.entries(RULE_FIELDS).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={14} />
        </label>
        {kind === 'list' && 'values' in rule && (
          <label className="select select--sm">
            <span className="visually-hidden">Condition</span>
            <select
              value={rule.op}
              onChange={(e) => onChange({ ...rule, op: e.target.value as 'any' | 'none' })}
            >
              <option value="any">is any of</option>
              <option value="none">is none of</option>
            </select>
            <Icon name="chevronDown" size={14} />
          </label>
        )}
        <IconButton icon="trash" label="Remove rule" onClick={onRemove} />
      </div>
      {kind === 'list' && 'values' in rule && (
        <ValuePicker
          rule={rule}
          facets={facets}
          onChange={(values) => onChange({ ...rule, values })}
        />
      )}
      {rule.op === 'between' && (
        <div className="range-inputs">
          {(['min', 'max'] as const).map((bound) => (
            <label key={bound}>
              <span className="field__label">{bound === 'min' ? 'At least' : 'At most'}</span>
              <input
                className="input input--sm"
                type="number"
                inputMode="decimal"
                value={rule[bound] ?? ''}
                onChange={(e) =>
                  onChange({
                    ...rule,
                    [bound]: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </label>
          ))}
        </div>
      )}
      {rule.field === 'watched' && (
        <Segmented
          label="Watch status"
          value={rule.value}
          onChange={(value) => onChange({ ...rule, value })}
          options={[
            { value: 'unwatched', label: 'Unwatched' },
            { value: 'inProgress', label: 'In progress' },
            { value: 'watched', label: 'Watched' },
          ]}
        />
      )}
      {rule.field === 'favorite' && (
        <Segmented
          label="Favorite"
          value={rule.value ? 'yes' : 'no'}
          onChange={(v) => onChange({ ...rule, value: v === 'yes' })}
          options={[
            { value: 'yes', label: 'Is a favorite' },
            { value: 'no', label: 'Not a favorite' },
          ]}
        />
      )}
      {rule.field === 'title' && (
        <input
          className="input input--sm"
          aria-label="Title contains"
          value={rule.value}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
        />
      )}
      {rule.field === 'addedWithinDays' && (
        <input
          className="input input--sm"
          type="number"
          min={1}
          aria-label="Days"
          value={rule.value}
          onChange={(e) => onChange({ ...rule, value: Number(e.target.value) })}
        />
      )}
    </li>
  );
}

function RulePreview({ rules }: { rules: SmartRules }) {
  const debounced = useDebounced(rules, 400);
  const key = JSON.stringify(debounced);
  const preview = useQuery({
    queryKey: ['rule-preview', key],
    queryFn: () =>
      api<{ count: number; sample: Movie[] }>('/collections/preview', {
        method: 'POST',
        body: { rules: debounced },
      }),
    retry: false,
    enabled: debounced.rules.length > 0,
  });
  if (debounced.rules.length === 0)
    return <p className="faint">Add a rule to see matching movies.</p>;
  if (preview.isError) return <p className="field__error">{errorMessage(preview.error)}</p>;
  if (!preview.data) return <p className="faint">Checking…</p>;
  return (
    <p className="rule-preview" aria-live="polite">
      <strong>{plural(preview.data.count, 'movie')}</strong> currently match
      {preview.data.sample.length > 0 &&
        `: ${preview.data.sample
          .slice(0, 4)
          .map((m) => m.title)
          .join(', ')}${preview.data.count > 4 ? '…' : ''}`}
    </p>
  );
}

export function CollectionEditor({
  open,
  onClose,
  collection,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  collection?: Collection;
  onSaved?: (id: string) => void;
}) {
  const { create, update } = useCollectionMutations();
  const facets = useFacets();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'manual' | 'smart'>('manual');
  const [shared, setShared] = useState(false);
  const [rules, setRules] = useState<SmartRules>({
    match: 'all',
    rules: [],
    sort: 'title',
    dir: 'asc',
    limit: null,
  });
  const [error, setError] = useState<string | null>(null);
  const initialised = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      initialised.current = null;
      return;
    }
    const key = collection?.id ?? 'new';
    if (initialised.current === key) return;
    initialised.current = key;
    setName(collection?.name ?? '');
    setDescription(collection?.description ?? '');
    setKind(collection?.kind ?? 'manual');
    setShared(collection?.visibility === 'shared');
    setRules(
      collection?.rules ?? { match: 'all', rules: [], sort: 'title', dir: 'asc', limit: null },
    );
    setError(null);
  }, [open, collection]);

  const busy = create.isPending || update.isPending;

  const save = async () => {
    setError(null);
    try {
      const body = {
        name,
        description,
        visibility: shared ? ('shared' as const) : ('private' as const),
        ...(kind === 'smart' ? { rules } : {}),
      };
      const result = collection
        ? await update.mutateAsync({ id: collection.id, ...body })
        : await create.mutateAsync({ ...body, kind });
      toast.show(collection ? 'Collection saved' : `Created ${result.name}`);
      onClose();
      onSaved?.(result.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={collection ? 'Edit collection' : 'New collection'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} busy={busy} disabled={!name.trim()}>
            {collection ? 'Save changes' : 'Create collection'}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              className="input"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Description" hint="Optional">
          {(id) => (
            <textarea
              id={id}
              className="input textarea"
              rows={2}
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        {!collection && (
          <div className="field">
            <span className="field__label">Type</span>
            <Segmented
              label="Collection type"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'manual', label: 'Hand-picked' },
                { value: 'smart', label: 'Smart (rule-based)' },
              ]}
            />
            <p className="field__hint">
              {kind === 'manual'
                ? 'You choose the movies and their order.'
                : 'Movies are added automatically when they match your rules — including new additions to the library.'}
            </p>
          </div>
        )}
        <Switch
          label="Share with everyone in the household"
          description="Shared collections are visible (read-only) to other Jellyfin users of this app."
          checked={shared}
          onChange={setShared}
        />

        {kind === 'smart' && (
          <section className="rules" aria-label="Rules">
            <div className="rules__head">
              <span className="field__label">Match</span>
              <Segmented
                label="Match"
                value={rules.match}
                onChange={(match) => setRules({ ...rules, match })}
                options={[
                  { value: 'all', label: 'All rules' },
                  { value: 'any', label: 'Any rule' },
                ]}
              />
            </div>
            <ul className="rules__list">
              {rules.rules.map((rule, i) => (
                <RuleRow
                  key={i}
                  rule={rule}
                  facets={facets.data}
                  onChange={(next) =>
                    setRules({ ...rules, rules: rules.rules.map((r, j) => (j === i ? next : r)) })
                  }
                  onRemove={() =>
                    setRules({ ...rules, rules: rules.rules.filter((_, j) => j !== i) })
                  }
                />
              ))}
            </ul>
            <Button
              variant="secondary"
              icon="plus"
              size="sm"
              onClick={() => setRules({ ...rules, rules: [...rules.rules, defaultRule('genre')] })}
            >
              Add rule
            </Button>
            <div className="rules__sort">
              <label className="select select--sm">
                <span className="field__label">Sort by</span>
                <select
                  value={rules.sort}
                  onChange={(e) =>
                    setRules({ ...rules, sort: e.target.value as SmartRules['sort'] })
                  }
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <Segmented
                label="Direction"
                value={rules.dir}
                onChange={(dir) => setRules({ ...rules, dir })}
                options={[
                  { value: 'asc', label: 'Ascending' },
                  { value: 'desc', label: 'Descending' },
                ]}
              />
              <label>
                <span className="field__label">Limit</span>
                <input
                  className="input input--sm"
                  type="number"
                  min={1}
                  placeholder="No limit"
                  value={rules.limit ?? ''}
                  onChange={(e) =>
                    setRules({ ...rules, limit: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </label>
            </div>
            <RulePreview rules={rules} />
            <p className="field__hint">
              Supported rules: genre, director, country, tag, studio, age rating, release year,
              runtime, community rating, my rating, watch status, favorite, title text and date
              added. Cast members, audio/subtitle languages and resolution are not supported as
              rules yet.
            </p>
          </section>
        )}
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
