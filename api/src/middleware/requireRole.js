/**
 * Requires user to have one of the allowed roles.
 * Use after requireAuth (JWT). req.user must have role.
 */
function requireRole(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return (req, res, next) => {
    const role = req.user && req.user.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { requireRole };
