'use client';

import { FC, useEffect, useState } from 'react';
import { MultiSelect } from '@gitroom/react/form/multi.select';
import { useCustomProviderFunction } from '@gitroom/frontend/components/launches/helpers/use.custom.provider.function';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';

// Fetches WordPress terms (categories or tags) for the connected site and wires
// the reusable MultiSelect primitive into the post settings form. Both fields
// are optional - selecting nothing leaves the value as an empty array, which
// the provider omits from the request entirely.
export const WordpressTerms: FC<{
  name: string;
  label: string;
  func: string;
  onChange: (event: {
    target: {
      value: number[];
      name: string;
    };
  }) => void;
}> = (props) => {
  const { name, label, func, onChange } = props;
  const { get } = useCustomProviderFunction();
  const form = useSettings();
  const { getValues } = form;
  const [terms, setTerms] = useState<Array<{ id: number; name: string }>>([]);
  const [selected, setSelected] = useState<Array<string | number>>(() => {
    const settings = getValues()[name];
    return Array.isArray(settings)
      ? settings.map((value: any) => Number(value))
      : [];
  });

  useEffect(() => {
    get(func).then((data) => setTerms(data || []));
  }, [get, func]);

  const onChangeInner = (value: Array<string | number>) => {
    const numbers = value.map((current) => Number(current));
    setSelected(numbers);
    form.setValue(name, numbers, { shouldValidate: true });
    onChange?.({ target: { name, value: numbers } });
  };

  if (!terms.length) {
    return null;
  }

  return (
    <MultiSelect
      name={name}
      label={label}
      value={selected}
      onChange={onChangeInner}
      options={terms.map((term) => ({ label: term.name, value: term.id }))}
    />
  );
};
