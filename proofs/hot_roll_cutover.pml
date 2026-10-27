/*
 * Spin (Promela) Model for Hot-Rolling SQL Schema Updates via Bidirectional Lenses
 * (L_{1->2}, L_{2->1}) and Session/Reload (HTTP 200) Feature-Flag Cohort Cutover.
 *
 * Models both:
 *   (A) Eager Atomic Dual-Write (PG trigger / Cloudflare D1 db.batch([stmt_v1, stmt_v2]))
 *   (B) Lazy-Backfill + Read-Repair / Write-Repair Gate (backfill-on-read before HTTP 200)
 *
 * Verify all LTL properties with:
 *   spin -a hot_roll_cutover.pml && gcc -O2 -o pan pan.c
 *   ./pan -a -N safety_no_lost_writes
 *   ./pan -a -N session_monotonicity_http200
 *   ./pan -a -N zero_loss_rollback
 */

byte val_v1 = 10;
byte val_v2 = 10;
byte rev_v1 = 0;
byte rev_v2 = 0;

/* Session S tracking for Cohort v1 -> HTTP 200 Reload -> Cohort v2 */
byte session_cohort = 1;       /* 1 = Cohort v1, 2 = Cohort v2 */
byte session_lsn = 0;          /* Highest revision committed by Session S */
byte http200_read_rev = 0;     /* Revision observed by Session S upon HTTP 200 v2 reload */
bool http200_reloaded = false;

/* Global accounting of committed mutations across both cohorts */
byte total_committed_writes = 0;
byte total_committed_delta = 0;
byte done_procs = 0;
bool rolled_back_to_v1 = false;
bool all_done = false;

/* Write in Cohort v1 (with Backward Lens L_{2->1} sync-on-write + optional eager/lazy L_{1->2}) */
inline write_v1(delta, out_rev) {
    atomic {
        if
        :: (rev_v1 < rev_v2) ->
            val_v1 = val_v2;
            rev_v1 = rev_v2
        :: else -> skip
        fi;
        val_v1 = val_v1 + delta;
        rev_v1 = rev_v1 + 1;
        /* Either eager dual-write (D1 db.batch / PG trigger) or lazy backfill on next v2 access */
        if
        :: val_v2 = val_v1; rev_v2 = rev_v1
        :: skip
        fi;
        out_rev = rev_v1;
        total_committed_writes = total_committed_writes + 1;
        total_committed_delta = total_committed_delta + delta
    }
}

/* Write in Cohort v2 (with Forward Lens L_{1->2} sync-on-write + eager Backward Lens L_{2->1}) */
inline write_v2(delta, out_rev) {
    atomic {
        if
        :: (rev_v2 < rev_v1) ->
            val_v2 = val_v1;
            rev_v2 = rev_v1
        :: else -> skip
        fi;
        val_v2 = val_v2 + delta;
        rev_v2 = rev_v2 + 1;
        /* Backward Lens L_{2->1} dual-write in same atomic tx / D1 batch */
        val_v1 = val_v2;
        rev_v1 = rev_v2;
        out_rev = rev_v2;
        total_committed_writes = total_committed_writes + 1;
        total_committed_delta = total_committed_delta + delta
    }
}

/* Session S: starts in Cohort v1, commits a mutation, reloads (HTTP 200) into Cohort v2 */
proctype MigratingSession() {
    byte my_rev = 0;

    /* Step 1: In-flight session in Cohort v1 writes delta = 5 */
    write_v1(5, my_rev);
    session_lsn = my_rev;

    /* Step 2: User triggers HTTP 200 page reload; feature flag promotes session to Cohort v2 */
    atomic {
        session_cohort = 2;
        /* Mandatory backfill-on-read gate before rendering HTTP 200 response */
        if
        :: (rev_v2 < rev_v1) ->
            val_v2 = val_v1;
            rev_v2 = rev_v1
        :: else -> skip
        fi;
        http200_read_rev = rev_v2;
        http200_reloaded = true;
        assert(http200_read_rev >= session_lsn)
    }

    /* Step 3: Post-cutover write in Cohort v2 (or v1 if rolled back) */
    if
    :: (!rolled_back_to_v1) -> write_v2(3, my_rev)
    :: (rolled_back_to_v1)  -> write_v1(3, my_rev)
    fi;
    session_lsn = my_rev;
    done_procs = done_procs + 1
}

/* Concurrent Worker in Cohort v2 mutating the same primary key k */
proctype ConcurrentCohortV2Writer() {
    byte w_rev = 0;
    write_v2(7, w_rev);
    done_procs = done_procs + 1
}

/* Rollback Controller: may non-deterministically abort v2 cutover at any time */
proctype RollbackController() {
    if
    :: atomic {
        if
        :: (rev_v1 < rev_v2) ->
            val_v1 = val_v2;
            rev_v1 = rev_v2
        :: else -> skip
        fi;
        rolled_back_to_v1 = true
       }
    :: skip
    fi;
    done_procs = done_procs + 1
}

init {
    atomic {
        run MigratingSession();
        run ConcurrentCohortV2Writer();
        run RollbackController()
    }
    (done_procs == 3);
    atomic {
        /* Final settle gate (L_{1->2} / L_{2->1} convergence) */
        if
        :: (rev_v2 < rev_v1) -> val_v2 = val_v1; rev_v2 = rev_v1
        :: (rev_v1 < rev_v2) -> val_v1 = val_v2; rev_v1 = rev_v2
        :: else -> skip
        fi;
        all_done = true;
        assert(val_v1 == val_v2);
        assert(rev_v1 == rev_v2);
        assert(val_v1 == 10 + total_committed_delta);
        assert(rev_v1 == total_committed_writes)
    }
}

ltl safety_no_lost_writes {
    [](all_done -> ((val_v1 == 10 + total_committed_delta) && (val_v2 == val_v1) && (rev_v1 == total_committed_writes)))
}

ltl session_monotonicity_http200 {
    [](http200_reloaded -> (http200_read_rev >= 1))
}

ltl zero_loss_rollback {
    []((all_done && rolled_back_to_v1) -> (val_v1 == 10 + total_committed_delta && rev_v1 == total_committed_writes))
}
