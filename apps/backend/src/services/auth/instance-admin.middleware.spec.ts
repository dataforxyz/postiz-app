import { InstanceAdminAuthMiddleware } from './instance-admin.middleware';

describe('InstanceAdminAuthMiddleware', () => {
  const mkRes = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  let mw: InstanceAdminAuthMiddleware;
  let originalKey: string | undefined;

  beforeEach(() => {
    mw = new InstanceAdminAuthMiddleware();
    originalKey = process.env.INSTANCE_ADMIN_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.INSTANCE_ADMIN_KEY;
    else process.env.INSTANCE_ADMIN_KEY = originalKey;
  });

  it('rejects with 401 when INSTANCE_ADMIN_KEY env is unset', () => {
    delete process.env.INSTANCE_ADMIN_KEY;
    const res = mkRes();
    const next = jest.fn();

    mw.use(
      { headers: { authorization: 'Bearer anything' } } as any,
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 when header missing', () => {
    process.env.INSTANCE_ADMIN_KEY = 'correct-admin-key';
    const res = mkRes();
    const next = jest.fn();

    mw.use({ headers: {} } as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 on mismatch', () => {
    process.env.INSTANCE_ADMIN_KEY = 'correct-admin-key';
    const res = mkRes();
    const next = jest.fn();

    mw.use(
      { headers: { authorization: 'Bearer wrong-key' } } as any,
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts Bearer-prefixed match and calls next', () => {
    process.env.INSTANCE_ADMIN_KEY = 'correct-admin-key';
    const res = mkRes();
    const next = jest.fn();

    mw.use(
      { headers: { authorization: 'Bearer correct-admin-key' } } as any,
      res,
      next
    );

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts raw (non-Bearer) match too', () => {
    process.env.INSTANCE_ADMIN_KEY = 'correct-admin-key';
    const res = mkRes();
    const next = jest.fn();

    mw.use(
      { headers: { authorization: 'correct-admin-key' } } as any,
      res,
      next
    );

    expect(next).toHaveBeenCalled();
  });

  it('rejects length mismatch without leaking (timing-safe check path)', () => {
    process.env.INSTANCE_ADMIN_KEY = 'aaaaaaaaaaaaaa';
    const res = mkRes();
    const next = jest.fn();

    mw.use(
      { headers: { authorization: 'Bearer a' } } as any,
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
