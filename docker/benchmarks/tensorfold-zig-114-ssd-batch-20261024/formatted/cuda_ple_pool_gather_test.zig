//! An in-memory affine table exercises the actual pooled gather without a checkpoint or device.
const std = @import("std");
const core = @import("core");
const ple = @import("cuda_ple.zig");
const pool = @import("cuda_ple_pool.zig");
const t = std.testing;

const Fixture = struct {
    g: ple.Ngram,
    weights: [2][512]u8 = @splat(@splat(0)),
    scales: [2][64]u8 = @splat(@splat(0)),
    biases: [2][64]u8 = @splat(@splat(0)),

    fn init(f: *Fixture) !void {
        f.* = .{ .g = .{ .gpa = t.allocator, .scale = 0.375, .hash = try ple.Hash.init(.{
            .vocab = 100,
            .ngram = 2,
            .per = 2,
            .base = 13,
            .divisor = 2,
            .shards = 2,
            .seed = 1234,
            .eos = 99,
            .ple_dim = 64,
            .ple_index = 0,
        }) } };
        for (0..2) |shard| {
            const rows: usize = @intCast(f.g.hash.starts[shard + 1] - f.g.hash.starts[shard]);
            try t.expect(rows * 16 <= f.weights[shard].len);
            try t.expect(rows * 2 <= f.scales[shard].len);
            for (0..rows) |r| {
                for (0..4) |word| {
                    var packed_word: u32 = 0;
                    for (0..8) |nibble| packed_word |= @as(u32, @intCast((r * 3 + word * 7 + nibble) % 16)) << @intCast(nibble * 4);
                    std.mem.writeInt(u32, f.weights[shard][r * 16 + word * 4 ..][0..4], packed_word, .little);
                }
                const scale = core.quant.convert.bf16(@as(f32, @floatFromInt(r % 3 + 1)) * 0.25);
                const bias = core.quant.convert.bf16(-@as(f32, @floatFromInt(r % 5)) * 0.125);
                std.mem.writeInt(u16, f.scales[shard][r * 2 ..][0..2], scale, .little);
                std.mem.writeInt(u16, f.biases[shard][r * 2 ..][0..2], bias, .little);
            }
            f.g.w[shard] = f.weights[shard][0 .. rows * 16];
            f.g.s[shard] = f.scales[shard][0 .. rows * 2];
            f.g.b[shard] = f.biases[shard][0 .. rows * 2];
        }
        f.g.pool = try pool.Pool.create(t.allocator, t.io);
    }
};

test "PLE gather: affine pool caller and arbitrary chunks retain row sums history and guards" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.g.deinit();
    var tokens: [257]u32 = undefined;
    for (&tokens, 0..) |*v, i| v.* = @intCast((i * 13 + 7) % 100);
    var expected: [257 * 64]u16 = undefined;
    var actual: [257 * 64 + 2]u16 = @splat(0xbeef);
    var want_xs: [257 * 2]f32 = undefined;
    var got_xs: [257 * 2]f32 = undefined;
    var want_history = [_]i64{99};
    {
        const parked = fixture.g.pool;
        fixture.g.pool = null;
        defer fixture.g.pool = parked;
        try fixture.g.rows(&want_history, &tokens, &expected, &want_xs);
    }
    var got_history = [_]i64{99};
    const ends = [_]usize{ 1, 8, 17, 33, 129, 257 };
    var begin: usize = 0;
    for (ends) |end| {
        try fixture.g.rows(&got_history, tokens[begin..end], actual[1 + begin * 64 .. 1 + end * 64], got_xs[begin * 2 .. end * 2]);
        begin = end;
    }
    try t.expectEqualSlices(u16, &expected, actual[1 .. actual.len - 1]);
    try t.expectEqualSlices(u8, std.mem.sliceAsBytes(&want_xs), std.mem.sliceAsBytes(&got_xs));
    try t.expectEqualSlices(i64, &want_history, &got_history);
    try t.expectEqual(@as(u16, 0xbeef), actual[0]);
    try t.expectEqual(@as(u16, 0xbeef), actual[actual.len - 1]);
}

test "PLE gather: shared table callers retain independent histories and destination bytes" {
    const Job = struct {
        g: *const ple.Ngram,
        tokens: [129]u32,
        history: [1]i64 = .{99},
        out: [129 * 64 + 2]u16 = @splat(0xcafe),
        xs: [129 * 2]f32 = undefined,
        failure: ?anyerror = null,

        fn run(j: *@This()) void {
            for (0..8) |_| {
                j.history = .{99};
                j.g.rows(&j.history, &j.tokens, j.out[1 .. j.out.len - 1], &j.xs) catch |err| {
                    j.failure = err;
                    return;
                };
            }
        }
    };
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.g.deinit();
    var jobs: [2]Job = undefined;
    for (&jobs, 0..) |*j, tag| {
        var tokens: [129]u32 = undefined;
        for (&tokens, 0..) |*v, i| v.* = @intCast((i * 11 + tag * 23) % 100);
        j.* = .{ .g = &fixture.g, .tokens = tokens };
    }
    var expected: [2][129 * 64]u16 = undefined;
    var expected_xs: [2][129 * 2]f32 = undefined;
    var expected_history: [2][1]i64 = .{ .{99}, .{99} };
    {
        const parked = fixture.g.pool;
        fixture.g.pool = null;
        defer fixture.g.pool = parked;
        for (&jobs, 0..) |*j, i| try fixture.g.rows(&expected_history[i], &j.tokens, &expected[i], &expected_xs[i]);
    }
    var threads: [2]?std.Thread = @splat(null);
    defer for (threads) |maybe| if (maybe) |th| th.join();
    for (&threads, &jobs) |*th, *j| th.* = try std.Thread.spawn(.{}, Job.run, .{j});
    for (&threads) |*maybe| {
        maybe.*.?.join();
        maybe.* = null;
    }
    for (&jobs, 0..) |*j, i| {
        try t.expectEqual(@as(?anyerror, null), j.failure);
        try t.expectEqualSlices(u16, &expected[i], j.out[1 .. j.out.len - 1]);
        try t.expectEqualSlices(u8, std.mem.sliceAsBytes(&expected_xs[i]), std.mem.sliceAsBytes(&j.xs));
        try t.expectEqualSlices(i64, &expected_history[i], &j.history);
        try t.expectEqual(@as(u16, 0xcafe), j.out[0]);
        try t.expectEqual(@as(u16, 0xcafe), j.out[j.out.len - 1]);
    }
}

test "PLE windows: mixed lengths and histories equal separate gathers byte for byte" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.g.deinit();
    const lengths = [_]usize{ 1, 6, 3, 17, 2, 1, 8, 7 };
    var tokens: [8][17]u32 = undefined;
    var expected_history: [8][1]i64 = undefined;
    var actual_history: [8][1]i64 = undefined;
    var windows: [8]ple.Ngram.Window = undefined;
    var expected: [45 * 64]u16 = undefined;
    var expected_xs: [45 * 2]f32 = undefined;
    var actual: [45 * 64 + 2]u16 = @splat(0xbeef);
    var actual_xs: [45 * 2]f32 = undefined;
    for (0..5) |repeat| {
        var at: usize = 0;
        for (lengths, 0..) |n, i| {
            for (&tokens[i], 0..) |*v, j| v.* = @intCast((j * 13 + i * 7 + repeat) % 100);
            tokens[i][0] = 99;
            expected_history[i] = .{@intCast((i * 11 + repeat) % 100)};
            actual_history[i] = expected_history[i];
            windows[i] = .{ .history = &actual_history[i], .tokens = tokens[i][0..n] };
            try fixture.g.rows(&expected_history[i], tokens[i][0..n], expected[at * 64 ..][0 .. n * 64], expected_xs[at * 2 ..][0 .. n * 2]);
            at += n;
        }
        try fixture.g.rowsMany(&windows, actual[1 .. actual.len - 1], &actual_xs);
        try t.expectEqualSlices(u16, &expected, actual[1 .. actual.len - 1]);
        try t.expectEqualSlices(u8, std.mem.sliceAsBytes(&expected_xs), std.mem.sliceAsBytes(&actual_xs));
        try t.expectEqualSlices(u8, std.mem.sliceAsBytes(&expected_history), std.mem.sliceAsBytes(&actual_history));
        try t.expectEqual(@as(u16, 0xbeef), actual[0]);
        try t.expectEqual(@as(u16, 0xbeef), actual[actual.len - 1]);
    }
}

test "PLE windows: malformed geometry and aliased histories fail before outputs or histories change" {
    var fixture: Fixture = undefined;
    try fixture.init();
    defer fixture.g.deinit();
    const tokens = [_]u32{ 7, 99, 8 };
    var h = [_]i64{42};
    var out: [6 * 64]u16 = @splat(0xcafe);
    var xs: [6 * 2]f32 = @splat(123);
    const alias = [_]ple.Ngram.Window{
        .{ .history = &h, .tokens = &tokens }, .{ .history = &h, .tokens = &tokens },
    };
    try t.expectError(error.UnexpectedTensor, fixture.g.rowsMany(&alias, &out, &xs));
    const one = [_]ple.Ngram.Window{.{ .history = &h, .tokens = &tokens }};
    try t.expectError(error.UnexpectedTensor, fixture.g.rowsMany(&one, &out, &xs));
    const empty = [_]ple.Ngram.Window{.{ .history = &h, .tokens = &.{} }};
    try t.expectError(error.UnexpectedTensor, fixture.g.rowsMany(&empty, &out, &xs));
    try t.expectError(error.UnexpectedTensor, fixture.g.rowsMany(&.{}, &out, &xs));
    try t.expectEqual(@as(i64, 42), h[0]);
    for (out) |value| try t.expectEqual(@as(u16, 0xcafe), value);
    for (xs) |value| try t.expectEqual(@as(f32, 123), value);
}
