import { ButtonLink, StatusView } from '../components/ui';

export function NotFoundPage() {
  return (
    <div className="page">
      <StatusView
        title="This page doesn’t exist"
        action={
          <ButtonLink to="/" variant="primary" icon="home">
            Back to Home
          </ButtonLink>
        }
      >
        <p>The link may be out of date.</p>
      </StatusView>
    </div>
  );
}
