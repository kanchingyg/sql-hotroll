DELETE FROM p WHERE id = (SELECT min(id) FROM p);
